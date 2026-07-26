#!/usr/bin/env node
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..');
function walk(d){return fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?e.name==='node_modules'?[]:walk(path.join(d,e.name)):[path.join(d,e.name)]);}
const tests=walk(root).map(p=>path.relative(root,p).replaceAll('\\','/')).filter(p=>/\.(test|spec)\.[cm]?[jt]sx?$/.test(p));
const exhaustive=p=>/contract\.test\.ts$|\.external\.test\.ts$|\.e2e\.test\.ts$|src\/utils\/clean-cut-round2\.test\.ts$|scripts\/snapshot-agent-surface\.test\.ts$|scripts\/tool-result-qa\/suite\.test\.ts$/.test(p);
const fast=tests.filter(p=>!exhaustive(p)), slow=tests.filter(exhaustive);
if(!tests.length||fast.some(exhaustive)||new Set([...fast,...slow]).size!==tests.length) throw Error('test lane closure failed');
console.log(JSON.stringify({tests:tests.length,fast:fast.length,exhaustive:slow.length}));
