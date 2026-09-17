'use strict';

const ROLES=Object.freeze(['exclude','product_detail','listing']);
function decode(value){try{return decodeURIComponent(String(value||''));}catch{return String(value||'');}}
function pathOf(raw){try{return decode(new URL(raw).pathname);}catch{return decode(raw);}}
function safePathPattern(pattern){
  const value=String(pattern||'');
  return value.length>2&&value.length<=240&&value.startsWith('^')&&value.endsWith('$')&&!/\\[1-9]|\(\?[=!<]|(?:\+|\*|\{\d+,?\d*\})\s*(?:\+|\*|\{)|\([^)]*(?:\+|\*|\{\d+,?\d*\})[^)]*\)\s*(?:\+|\*|\{)/.test(value);
}
function roleMatchesPath(raw,rules,role){
  const path=pathOf(raw),exact=(rules?.[`${role}_paths`]||[]).map(pathOf),patterns=rules?.[`${role}_path_patterns`]||[];
  if(exact.includes(path))return true;
  for(const pattern of patterns)if(safePathPattern(pattern)){try{if(new RegExp(pattern,'u').test(path))return true;}catch{}}
  if(exact.length||patterns.length)return false;
  return (rules?.[`${role}_path_prefixes`]||[]).some(prefix=>path.startsWith(pathOf(prefix)));
}
function urlRole(raw,rules){
  const order=Array.isArray(rules?.matching_priority)?rules.matching_priority:['exclude','product_detail','listing'];
  for(const role of order)if(ROLES.includes(role)&&roleMatchesPath(raw,rules,role))return role;
  return 'unknown';
}
function escapeRegex(value){return String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
function siblingFilePattern(urls){
  const paths=[...new Set((urls||[]).map(pathOf).filter(Boolean))];if(paths.length<3)return null;
  const parsed=paths.map(value=>{const slash=value.lastIndexOf('/'),leaf=value.slice(slash+1),dot=leaf.lastIndexOf('.');return {dir:value.slice(0,slash+1),extension:dot>0?leaf.slice(dot):''};});
  if(!parsed[0].extension||!parsed.every(item=>item.dir===parsed[0].dir&&item.extension===parsed[0].extension))return null;
  return `^${escapeRegex(parsed[0].dir)}[^/]+${escapeRegex(parsed[0].extension)}$`;
}

module.exports={ROLES,pathOf,safePathPattern,roleMatchesPath,urlRole,siblingFilePattern};
