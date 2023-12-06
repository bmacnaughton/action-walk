#!/usr/bin/env node
const walk = require('..');
/* eslint-disable no-console */

const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-t' || args[i] === '--include-top-level') {
    args.splice(i, 1);
    options.includeTopLevel = true;
  }
}

if (args.length < 1) {
  console.log('usage: action-walk [--include-top-level] directory');
  process.exit(1);
}
const dir = args[0];

const own = {total: 0};
Object.assign(options, {dirAction, fileAction, own, stat: 'lstat'});

async function main () {
  return walk(dir, options);
}

main()
  .then(() => {
    console.log(own);
  })

function dirAction (path, ctx) {
  const {dirent, stat, own} = ctx;
  console.log(`${dirent.name}/`, stat.size);
  own.total += stat.size;
}
function fileAction (path, ctx) {
  const {dirent, stat, own} = ctx;
  if (dirent.isSymbolicLink()) {
    console.log(dirent.name, '->', stat.size);
  } else {
    console.log(dirent.name, stat.size);
  }
  own.total += stat.size;
}
