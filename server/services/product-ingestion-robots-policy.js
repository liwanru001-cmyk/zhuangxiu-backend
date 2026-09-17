'use strict';

const crypto = require('crypto');

const USER_AGENT_TOKEN = 'ZhuangXiaoWoBot';
const PARSER_NAME = 'google-robotstxt-parser';
const PARSER_VERSION = '1.2.0';
let parserModule;

async function parser() {
  if (!parserModule) parserModule = import('google-robotstxt-parser');
  return parserModule;
}

function canonicalRobotsUrl(raw) {
  const url = new URL(raw);
  url.hash = '';
  url.pathname = url.pathname.replace(/%[0-9a-f]{2}/gi, value => value.toUpperCase());
  url.search = url.search.replace(/%[0-9a-f]{2}/gi, value => value.toUpperCase());
  return url.toString();
}

function lineAt(content, lineNumber) {
  if (!lineNumber) return null;
  const line = String(content || '').split(/\r?\n/)[lineNumber - 1]?.replace(/#.*$/, '').trim();
  return line || null;
}

function sitemapDirectives(content, baseUrl) {
  const result = [];
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const match = rawLine.replace(/#.*$/, '').trim().match(/^sitemap\s*:\s*(.+)$/i);
    if (!match) continue;
    try {
      const url = new URL(match[1].trim(), baseUrl);
      if (['http:', 'https:'].includes(url.protocol)) result.push(url.toString());
    } catch (_) {}
  }
  return [...new Set(result)];
}

async function evaluateRobots(content, rawUrl, userAgent = USER_AGENT_TOKEN) {
  const { RobotsMatcher } = await parser();
  const matcher = new RobotsMatcher();
  const url = canonicalRobotsUrl(rawUrl);
  const allowed = matcher.oneAgentAllowedByRobots(String(content || ''), userAgent, url);
  const matchingLine = matcher.matchingLine();
  return {
    allowed,
    decision: allowed ? 'ALLOW' : 'DENY',
    reason_code: allowed ? 'ROBOTS_ALLOWED' : 'ROBOTS_DISALLOW',
    matched_rule: lineAt(content, matchingLine),
    matching_line: matchingLine || null,
    url,
  };
}

function contentHash(content) {
  return crypto.createHash('sha256').update(String(content || '')).digest('hex');
}

module.exports = {
  USER_AGENT_TOKEN,
  PARSER_NAME,
  PARSER_VERSION,
  canonicalRobotsUrl,
  evaluateRobots,
  sitemapDirectives,
  contentHash,
};
