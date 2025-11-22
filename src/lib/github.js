import dotenv from 'dotenv';

dotenv.config();

/**
 * Fetch GitHub profile and repository information
 */

/**
 * Get GitHub API headers with authentication
 * @returns {Object} - Headers object for GitHub API requests
 */
function getGitHubHeaders() {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // Add Bearer token if available
  const githubToken = process.env.GITHUB_TOKEN;
  if (githubToken) {
    headers['Authorization'] = `Bearer ${githubToken}`;
  } else {
    console.warn('[GitHub] GITHUB_TOKEN not set in environment variables. API requests may be rate-limited.');
  }

  return headers;
}

/**
 * Extract username from GitHub URL
 * @param {string} url - GitHub URL (e.g., https://github.com/username, github.com/username, or just username)
 * @returns {string|null} - Username or null if invalid
 */
export function extractGitHubUsername(url) {
  if (!url) return null;
  
  // Trim whitespace
  url = url.trim();
  
  // If it's just a username (no slashes, no dots, no protocol), return it directly
  if (!url.includes('/') && !url.includes('.') && !url.includes('http')) {
    // Basic validation: username should be alphanumeric with hyphens and underscores
    if (/^[a-zA-Z0-9]([a-zA-Z0-9]|-(?![.-])){0,38}$/.test(url)) {
      return url;
    }
  }
  
  // Normalize URL: add https:// if protocol is missing
  let normalizedUrl = url;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    normalizedUrl = `https://${url}`;
  }
  
  try {
    const urlObj = new URL(normalizedUrl);
    
    // Check if it's a GitHub domain
    if (urlObj.hostname !== 'github.com' && urlObj.hostname !== 'www.github.com') {
      return null;
    }
    
    // Extract username from path (e.g., /username or /username/repo)
    const pathParts = urlObj.pathname.split('/').filter(p => p);
    if (pathParts.length === 0) return null;
    
    // Return the first path part as username
    return pathParts[0];
  } catch (error) {
    // If URL parsing fails, try to extract username from common patterns
    // Pattern: github.com/username or www.github.com/username
    const githubPattern = /(?:github\.com|www\.github\.com)[\/:]([a-zA-Z0-9]([a-zA-Z0-9]|-(?![.-])){0,38})/i;
    const match = url.match(githubPattern);
    if (match && match[1]) {
      return match[1];
    }
    
    console.error('[GitHub] Error parsing URL:', error);
    return null;
  }
}

/**
 * Fetch GitHub user profile and repositories
 * @param {string} githubUrl - GitHub profile URL (supports: https://github.com/username, github.com/username, or just username)
 * @returns {Promise<Object>} - User profile and repositories data
 */
export async function fetchGitHubData(githubUrl) {
  if (!githubUrl || typeof githubUrl !== 'string') {
    return { error: 'GitHub URL is required' };
  }
  
  const username = extractGitHubUsername(githubUrl);
  if (!username) {
    console.error(`[GitHub] Failed to extract username from: ${githubUrl}`);
    return { error: `Invalid GitHub URL: ${githubUrl}. Expected format: https://github.com/username, github.com/username, or just username` };
  }
  
  console.log(`[GitHub] Extracted username: ${username} from URL: ${githubUrl}`);

  try {
    const headers = getGitHubHeaders();

    // Fetch user profile
    const profileResponse = await fetch(`https://api.github.com/users/${username}`, {
      headers,
    });

    if (!profileResponse.ok) {
      if (profileResponse.status === 404) {
        return { error: 'GitHub user not found' };
      }
      if (profileResponse.status === 401 || profileResponse.status === 403) {
        return { error: 'GitHub API authentication failed. Please check GITHUB_TOKEN.' };
      }
      return { error: `GitHub API error: ${profileResponse.status}` };
    }

    const profile = await profileResponse.json();

    // Fetch user repositories (public repos, sorted by updated date, limit to 20 most recent)
    const reposResponse = await fetch(
      `https://api.github.com/users/${username}/repos?sort=updated&per_page=20&type=all`,
      {
        headers,
      }
    );

    let repos = [];
    if (reposResponse.ok) {
      repos = await reposResponse.json();
    }

    // Extract relevant information from repositories
    const repoData = repos.map(repo => ({
      name: repo.name,
      description: repo.description || '',
      language: repo.language || '',
      stars: repo.stargazers_count || 0,
      forks: repo.forks_count || 0,
      updated_at: repo.updated_at,
      topics: repo.topics || [],
      homepage: repo.homepage || '',
      html_url: repo.html_url,
    }));

    return {
      username: profile.login,
      name: profile.name || '',
      bio: profile.bio || '',
      company: profile.company || '',
      location: profile.location || '',
      blog: profile.blog || '',
      public_repos: profile.public_repos || 0,
      followers: profile.followers || 0,
      following: profile.following || 0,
      created_at: profile.created_at,
      repositories: repoData,
    };
  } catch (error) {
    console.error('[GitHub] Error fetching GitHub data:', error);
    return { error: error.message || 'Failed to fetch GitHub data' };
  }
}

/**
 * Format GitHub data for LLM prompt
 * @param {Object} githubData - GitHub data from fetchGitHubData
 * @returns {string} - Formatted string for LLM
 */
export function formatGitHubDataForLLM(githubData) {
  if (githubData.error) {
    return `GitHub Error: ${githubData.error}`;
  }

  let formatted = `GitHub Profile: ${githubData.username}\n`;
  if (githubData.name) formatted += `Name: ${githubData.name}\n`;
  if (githubData.bio) formatted += `Bio: ${githubData.bio}\n`;
  if (githubData.company) formatted += `Company: ${githubData.company}\n`;
  if (githubData.location) formatted += `Location: ${githubData.location}\n`;
  if (githubData.blog) formatted += `Website: ${githubData.blog}\n`;
  formatted += `Public Repositories: ${githubData.public_repos}\n`;
  formatted += `Followers: ${githubData.followers}, Following: ${githubData.following}\n`;
  formatted += `Account Created: ${githubData.created_at}\n\n`;

  if (githubData.repositories && githubData.repositories.length > 0) {
    formatted += `Repositories (${githubData.repositories.length} most recent):\n`;
    githubData.repositories.forEach((repo, index) => {
      formatted += `\n${index + 1}. ${repo.name}`;
      if (repo.description) formatted += ` - ${repo.description}`;
      formatted += `\n   Language: ${repo.language || 'N/A'}`;
      formatted += ` | Stars: ${repo.stars} | Forks: ${repo.forks}`;
      if (repo.topics && repo.topics.length > 0) {
        formatted += ` | Topics: ${repo.topics.join(', ')}`;
      }
      if (repo.homepage) formatted += ` | Homepage: ${repo.homepage}`;
      formatted += `\n   URL: ${repo.html_url}`;
      formatted += `\n   Last Updated: ${repo.updated_at}`;
    });
  } else {
    formatted += '\nNo public repositories found.';
  }

  return formatted;
}
