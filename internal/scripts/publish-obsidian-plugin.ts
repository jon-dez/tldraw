import { existsSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { Octokit } from '@octokit/rest'
import { parse } from 'semver'
import { exec } from './lib/exec'
import { makeEnv } from './lib/makeEnv'
import { nicelog } from './lib/nicelog'

// PLUGIN_RELEASE_GITHUB_REPOSITORY needs to be set. It is used to get the latest release version and to publish the release.
// PLUGIN_RELEASE_GH_TOKEN needs to be set. It is a GitHub token with access to the plugin release repository.
const env = makeEnv(['TLDRAW_ENV', 'PLUGIN_RELEASE_GH_TOKEN', 'PLUGIN_RELEASE_GITHUB_REPOSITORY'])

const PLUGIN_DIR = 'apps/obsidian'
const BUILD_DIR = path.join(PLUGIN_DIR, 'dist/production')

/**
 * Validates that a version string is in strict x.y.z format (no prerelease or build metadata).
 * Obsidian plugin versions must follow this format.
 * 
 * @see https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin#Step+2+Create+a+release
 * 
 * @param version - The version string to validate
 * @returns An object with `isValid` boolean and optional `error` message
 */
function validateStrictVersion(version: string): { isValid: boolean; error?: string } {
	const semVer = parse(version)
	if (!semVer) {
		return {
			isValid: false,
			error: `Could not parse version: ${version}`,
		}
	}

	if (semVer.prerelease.length > 0 || semVer.build.length > 0) {
		return {
			isValid: false,
			error: `Version must be in x.y.z format, but got: ${version} (contains prerelease or build metadata)`,
		}
	}

	return { isValid: true }
}

/**
 * Get the plugin release repository owner and name for GitHub API calls.
 * 
 * The Obsidian plugin is published from a separate GitHub repository to avoid conflicts with releases tagged in the
 * monorepo.
 * 
 * Requires PLUGIN_RELEASE_GITHUB_REPOSITORY environment variable to be set (format: owner/repo).
 */
function getPluginReleaseRepoInfo() {
	const [owner, repo] = env.PLUGIN_RELEASE_GITHUB_REPOSITORY.split('/')
	if (!owner || !repo) {
		throw new Error(
			`PLUGIN_RELEASE_GITHUB_REPOSITORY must be in format 'owner/repo', got: ${env.PLUGIN_RELEASE_GITHUB_REPOSITORY}`
		)
	}
	return { owner, repo }
}

/**
 * Get the monorepo repository owner and name (where the action is running).
 * 
 * Uses GITHUB_REPOSITORY from GitHub Actions context.
 */
function getMonorepoRepoInfo() {
	const repoEnv = process.env.GITHUB_REPOSITORY
	if (!repoEnv) {
		throw new Error('GITHUB_REPOSITORY environment variable is not set')
	}
	const [owner, repo] = repoEnv.split('/')
	return { owner, repo }
}

async function getLatestReleaseVersion(octokit: Octokit, owner: string, repo: string): Promise<string> {
	try {
		const { data: releases } = await octokit.repos.listReleases({
			owner,
			repo,
			per_page: 1,
		})

		if (releases.length > 0) {
			const tag = releases[0].tag_name
			// Remove 'v' prefix if present
			return tag.startsWith('v') ? tag.slice(1) : tag
		}
	} catch (error: any) {
		if (error.status === 404) {
			nicelog('No releases found, will use manifest version as fallback')
		} else {
			nicelog('Could not fetch latest release, using manifest version as fallback:', error.message)
		}
	}

	// Fallback to reading from manifest.json
	const manifestPath = path.join(PLUGIN_DIR, 'manifest.json')
	if (existsSync(manifestPath)) {
		const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
		return manifest.version
	}

	throw new Error('Could not determine latest version')
}

async function updatePluginVersion(octokit: Octokit, owner: string, repo: string) {
	const currentVersion = await getLatestReleaseVersion(octokit, owner, repo)
	
	// Validate current version - log warning if invalid but continue
	const currentValidation = validateStrictVersion(currentVersion)
	if (!currentValidation.isValid) {
		nicelog(`⚠️  Warning: ${currentValidation.error}`)
		nicelog('   Continuing with version bump, but the current version may not be in the expected format.')
	}

	const semVer = parse(currentVersion)
	if (!semVer) {
		throw new Error(`Could not parse version: ${currentVersion}`)
	}

	const release = env.TLDRAW_ENV === 'production' ? 'minor' : 'patch'
	const nextVersion = semVer.inc(release).version
	
	// Validate the incremented version - throw error if invalid since we're creating it
	const nextValidation = validateStrictVersion(nextVersion)
	if (!nextValidation.isValid) {
		throw new Error(`Incremented version validation failed: ${nextValidation.error}`)
	}

	nicelog(`Updating plugin version from ${currentVersion} to ${nextVersion}`)

	// Update package.json
	const packageJsonPath = path.join(PLUGIN_DIR, 'package.json')
	const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
	packageJson.version = nextVersion
	writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, '\t') + '\n')

	// Update manifest.json and versions.json via version script
	await exec('yarn', ['run', 'version'], {
		pwd: PLUGIN_DIR,
		env: { target_version: nextVersion },
	})

	return nextVersion
}

async function buildPlugin() {
	nicelog('Building packages...')
	await exec('yarn', ['lazy', 'run', 'build', '--filter=packages/*'])

	nicelog('Building Obsidian plugin...')
	await exec('yarn', ['build'], { pwd: PLUGIN_DIR })

	// Verify build outputs exist
	const requiredFiles = ['main.js', 'styles.css', 'manifest.json']
	for (const file of requiredFiles) {
		const filePath = path.join(BUILD_DIR, file)
		if (!existsSync(filePath)) {
			throw new Error(`Required build file not found: ${filePath}`)
		}
	}
	nicelog('Build completed successfully')
}

async function getLatestReleaseTag(octokit: Octokit, owner: string, repo: string): Promise<string> {
	try {
		const { data: releases } = await octokit.repos.listReleases({
			owner,
			repo,
			per_page: 1,
		})

		if (releases.length > 0) {
			const tag = releases[0].tag_name
			// Obsidian plugin tags are in x.y.z format (no 'v' prefix)
			return tag.startsWith('v') ? tag.slice(1) : tag
		}
	} catch (_error) {
		nicelog('Could not fetch latest release tag')
	}

	return '1.0.0'
}

async function createRelease(
	version: string,
	octokit: Octokit,
	owner: string,
	repo: string
) {
	// Obsidian plugin tags must be in x.y.z format (no 'v' prefix)
	const tag = version

	nicelog(`Creating GitHub release: ${tag}`)

	// Check if release already exists in the separate repository
	try {
		await octokit.repos.getReleaseByTag({
			owner,
			repo,
			tag,
		})
		nicelog(`Release ${tag} already exists in ${owner}/${repo}, skipping`)
		return
	} catch (error: any) {
		if (error.status !== 404) {
			throw error
		}
		// 404 is expected if release doesn't exist, continue
	}

	// Set git user identity for monorepo commits
	nicelog('Setting git user identity...')
	await exec('git', ['config', 'user.name', 'huppy-bot[bot]'])
	await exec('git', ['config', 'user.email', '128400622+huppy-bot[bot]@users.noreply.github.com'])

	// Commit version changes to the monorepo
	nicelog('Committing version changes to monorepo...')
	await exec('git', ['add', path.join(PLUGIN_DIR, 'package.json')])
	await exec('git', ['add', path.join(PLUGIN_DIR, 'manifest.json')])
	await exec('git', ['add', path.join(PLUGIN_DIR, 'versions.json')])
	await exec('git', ['commit', '-m', `Bump Obsidian plugin to ${version} [skip ci]`])
	nicelog('Pushing changes to monorepo...')
	await exec('git', ['push'])

	// Get the default branch of the separate repository for the release target
	let targetCommitish = 'main'
	try {
		const { data: repoData } = await octokit.repos.get({ owner, repo })
		targetCommitish = repoData.default_branch
	} catch (_error) {
		nicelog(`Could not get default branch for ${owner}/${repo}, using 'main' as fallback`)
	}

	const prevTag = await getLatestReleaseTag(octokit, owner, repo)
	const compareUrl = `https://github.com/${owner}/${repo}/compare/${prevTag}...${tag}`

	// Create GitHub release in the separate repository
	// GitHub will automatically create the tag if it doesn't exist
	const isPrerelease = env.TLDRAW_ENV === 'staging'

	nicelog(`Creating GitHub release in ${owner}/${repo} (prerelease: ${isPrerelease})...`)
	await octokit.repos.createRelease({
		owner,
		repo,
		tag_name: tag,
		name: tag,
		target_commitish: targetCommitish,
		body: `## Changes\n\nSee [changelog](${compareUrl}) for details.`,
		draft: false,
		prerelease: isPrerelease,
	})

	nicelog(`Release ${tag} created successfully in ${owner}/${repo}`)
}

async function main() {
	const pluginRepo = getPluginReleaseRepoInfo()
	const monorepoRepo = getMonorepoRepoInfo()
	
	nicelog(`Publishing Obsidian plugin`)
	nicelog(`  Monorepo: ${monorepoRepo.owner}/${monorepoRepo.repo}`)
	nicelog(`  Plugin release repository: ${pluginRepo.owner}/${pluginRepo.repo}`)

	const pluginReleaseOctokit = new Octokit({ auth: env.PLUGIN_RELEASE_GH_TOKEN })
	const version = await updatePluginVersion(pluginReleaseOctokit, pluginRepo.owner, pluginRepo.repo)
	await buildPlugin()
	await createRelease(version, pluginReleaseOctokit, pluginRepo.owner, pluginRepo.repo)
}

main().catch(async (err) => {
	console.error(err)
	process.exit(1)
})
