'use strict';

const cp = require('node:child_process');
const p = require('node:path');

const BYTES = Symbol('bytes');

async function getExpectedValuesWin(rootdir, duOutput, findOutput, dirtreeRoot) {
  const rootDirResolved = p.resolve(rootdir);

  let results = cp.spawnSync('.\\scripts\\file-sizes.ps1', [rootdir], {shell: 'powershell.exe'});

  let lines1 = results.stdout.toString();
  let lines2 = lines1.split('\n');

  const re = new RegExp('^(\\d+) ' + rootDirResolved.replace(/\\/g, '\\\\') + '(.+) (d|f)$');
  let count = 0;

  const wo_node = {};
  const w_node = {};
  const directories = {};
  const files = {};
  dirtreeRoot[rootdir] = {[BYTES]: 0};

  let wo_total = 0;
  let w_total = 0;


  // simulate approximately what 'du -ab' does.
  for (const line of lines2) {
    const m = line.match(re);
    if (m) {
      console.log(line)
      const bytes = +m[1];

      const fullpath = line.slice(m[1].length + 1, -(m[3].length + 1));
      // make the start of our paths the rootdir.
      const relativePath = fullpath.replace(rootDirResolved, rootdir);

      // the path elements as an array, e.g., ['node_modules', '@contrast', ...]
      const relativePathElements = relativePath.split(p.sep);

      // start at the root each time
      let treeStack = [dirtreeRoot];

      // aggregate counts for each item in the tree. each tree entry is
      // an object containing all leaf items and sub-trees. it also keeps
      // the byte count for all leaf and sub-tree items.
      //
      // add each element's size to the predecessor byte counts because all
      // items in the path contain the element.
      for (let i = 0; i < relativePathElements.length; i++) {
        const nextElement = relativePathElements[i];

        // if this is the first time we've seen nextElement, add it to
        // the previous element. otherwise just add to the byte count.
        if (!(nextElement in treeStack.at(-1))) {
          const newItem = {[BYTES]: bytes};
          treeStack.at(-1)[nextElement] = newItem;
          treeStack.push(newItem);
        } else {
          treeStack.at(-1)[nextElement][BYTES] += bytes;
          treeStack.push(treeStack.at(-1)[nextElement]);
        }
      }

      w_node[relativePath] = bytes;
      w_total += w_node[relativePath];

      if (!['node_modules'].includes(relativePathElements[0])) {
        wo_node[relativePath] = bytes;
        wo_total += wo_node[relativePath];
      }

      if (m[3] === 'd') {
        directories[relativePath] = bytes;
      } else if (m[3] === 'f') {
        files[relativePath] = bytes;
      } else if (m[3] === 'l') {
        // it's a link...
      }
    } else {
      // don't know how to suppress ps noise. have changed login script and it
      // is still running old one it seems.
      //console.log('unexpected line', line);
    }
  }
  // now insert rootdir totals; the powershell command doesn't report on
  // the rootdir itself.
  wo_node[rootdir] = wo_total;
  w_node[rootdir] = w_total;

  duOutput.wo_node = wo_node;
  duOutput.w_node = w_node;
  findOutput.directories = directories;
  findOutput.files = files;

  return dirtreeRoot;
}


const duOutput = {};
const findOutput = {};
const dirtreeRoot = {};

const util = require('node:util');
const rootdir = process.argv[2] || '.';

getExpectedValuesWin(rootdir, duOutput, findOutput, dirtreeRoot)
  .then(() => {
    console.log(duOutput, util.inspect(dirtreeRoot, {depth: 10}));
    console.log(walktree(dirtreeRoot));
  });


function walktree(tree) {
  const branch = [];
  const results = [];

  function _walktree(tree) {
    for (const key of Object.keys(tree)) {
      branch.push(key);
      _walktree(tree[key], branch);
      results.push({path: branch.join(p.sep), bytes: tree[key][BYTES]});
      //console.log(branch.join(p.sep), tree[key][BYTES])
      branch.pop();
    }
  }
  _walktree(tree);

  return results;
}
