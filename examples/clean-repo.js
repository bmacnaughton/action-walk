#!/usr/bin/env node

'use strict';

//
// implementation of a script to delete node_modules/.cache and dist
// directories from a mono-repo. feel free to create some dist and
// node_modules/.cache/@bmacnaughton/action-walk directories to make
// the example really work...
//

const fs = require('fs');
const fsp = require('fs/promises');

// replace with @bmacnaughton/action-walk to used in your own project.
const walk = require('../action-walk.js');

function dirAction(path, context) {
  const { dirent, own } = context;

  // we want to go into node_modules directories but only to find a
  // node_modules/.cache directory.
  if (path.endsWith(`node_modules/${dirent.name}`)) {
    // if it's not cache, skip it.
    if (dirent.name !== '.cache') {
      return 'skip';
    }

    // the directory is named .cache, so delete it if requested. (action-walk
    // doesn't create a cache, but this is just an example.)
    const cachePath = `${path}/@bmacnaughton/action-walk`;
    if (!own.deleteCache) {
      console.log(`[DRY RUN: deleting ${cachePath}]`);
      return 'skip';
    }
    // it is node_modules/.cache, so asynchronously delete @contrast/rasp-v3
    // recursively and return skip without waiting for the delete to finish.
    // this allows action-walk to continue traversing the directory tree while
    // the delete is in progress.
    deleteDirectoryTree(cachePath);

    return 'skip';
  }

  // we are not under a node_modules directory due to the previous checks, so
  // check if this is a dist directory.
  if (dirent.name === 'dist') {
    if (!own.deleteDist) {
      console.log(`[DRY_RUN: deleting ${path}]`);
      return 'skip';
    }

    // it is a dist directory that is not under a node_modules directory. do the same
    // asynchronous delete as above.
    deleteDirectoryTree(path);

    return 'skip';
  }

  // this directory is not node_modules/* or dist, so walk it.

}

// asynchronously delete a directory tree and output status info to the
// console.
async function deleteDirectoryTree(path) {
  return fsp.rm(path, {recursive: true})
    .then(() => {
      console.log(`[deleted ${path}]`);
    })
    .catch(e => {
      if (e.code === 'ENOENT') {
        console.log(`? ${path} does not exist`);
      } else {
        console.log(`? ERROR deleting ${path}}`, e.code, e.message);
      }
    });
}

const options = {
  dirAction,
  own: {
    deleteCache: false,
    deleteDist: false,
  },
};

(function main() {
  // because this deletes directories make sure it's run from where it's
  // intended to be run.
  let packageDotJson;
  try {
    const pdj = fs.readFileSync('package.json', 'utf8');
    packageDotJson = JSON.parse(pdj);
  } catch (e) {
    console.log(`? cannot read package.json ${e.message}; aborting`);
    process.exit(1);
  }

  if (packageDotJson.name !== '@bmacnaughton/action-walk') {
    console.log('? this script must be run from the mono-repo root');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  for (const arg of args) {
    if (arg === 'cache') {
      options.own.deleteCache = true;
    } else if (arg === 'dist') {
      options.own.deleteDist = true;
    } else if (arg === 'all') {
      options.own.deleteCache = true;
      options.own.deleteDist = true;
    }
  }

  if (!options.own.deleteCache && !options.own.deleteDist) {
    console.log('! neither cache nor dist was specified; executing dry run');
  }

  walk('.', options)
    .then(() => {
      console.log('done');
    });
})();
