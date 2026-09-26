#!/usr/bin/env node
// Devspaces and agent runs are only for public repositories: their logs and
// transcripts are public. Exits 0 only if GitHub says OWNER/REPO is public;
// anything else, including an API error, fails closed.
//   public-repo.mjs OWNER/REPO    (GH_TOKEN, if set, authenticates)
import { pathToFileURL } from "node:url";

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export async function isPublicRepo(repo, token = process.env.GH_TOKEN) {
  if (!REPO_RE.test(repo ?? "")) {
    throw new Error(`not a repository name: '${repo}'`);
  }
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "cgwalters-devspace-sandbox" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(`https://api.github.com/repos/${repo}`, { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for ${repo}`);
  }
  const { private: isPrivate, visibility } = await response.json();
  return isPrivate === false && visibility === "public";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repo = process.argv[2];
  try {
    if (!(await isPublicRepo(repo))) {
      throw new Error(`${repo} is not public`);
    }
    console.log(`${repo} is public`);
  } catch (e) {
    console.error(`error: refusing ${repo}, as it can't be confirmed public: ${e.message}`);
    process.exit(1);
  }
}
