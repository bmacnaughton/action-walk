'use strict';

const cp = require('node:child_process');
const p = require('node:path');

const testdir = process.argv[2] || '.';
const testDirResolved = p.resolve(testdir);
console.log(testdir, testDirResolved);
const BYTES = Symbol('bytes');

async function getExpectedValuesWin(duOutput, findOutput, dirtreeRoot) {
  let results = cp.spawnSync('.\\scripts\\file-sizes.ps1', [testdir], {shell: 'powershell.exe'});

  let lines1 = results.stdout.toString();
  let lines2 = lines1.split('\n');

  const re = new RegExp('^(\\d+) ' + testDirResolved.replace(/\\/g, '\\\\') + '(.+) (True|False)$');
  let count = 0;

  const wo_node = {};
  const w_node = {};
  const directories = {};
  const files = {};
  dirtreeRoot[testdir] = {[BYTES]: 0};

  let wo_total = 0;
  let w_total = 0;


  // this doesn't really do what "du -ab" does, but the test only requires
  // the right information for testdir.
  for (const line of lines2) {
    const m = line.match(re);
    if (m) {
      const bytes = +m[1];
      const path = m[2];
      const isDir = m[3] === 'True';
      const fullpath = line.slice(m[1].length + 1, -(m[3].length + 1));
      const duEquivPath = fullpath.replace(testDirResolved, testdir);
      const duEquivPathStack = duEquivPath.split(p.sep);
      console.log(duEquivPathStack)


      let depth = 0;
      let treeStack = [dirtreeRoot];

      for (let i = 0; i < duEquivPathStack.length; i++) {
        const nextItemName = duEquivPathStack[i];
        if (!(nextItemName in treeStack.at(-1))) {
          const newItem = {[BYTES]: bytes};
          treeStack.at(-1)[nextItemName] = newItem;
          treeStack.push(newItem);
        } else {
          treeStack.at(-1)[nextItemName][BYTES] += bytes;
          treeStack.push(treeStack.at(-1)[nextItemName]);
        }
      }

      w_node[duEquivPath] = +m[1];
      w_total += w_node[duEquivPath];
      //w_node.push({size: +m[1], name: m[2], directory: m[3] === 'True'});

      if (!m[2].startsWith('\\node_modules')) {
        wo_node[duEquivPath] = +m[1];
        wo_total += wo_node[duEquivPath];
        //wo_node.push({size: +m[1], name: m[2], directory: m[3] === 'True'});
      }


      if (m[3] === 'True') {
        directories[duEquivPath] = +m[1];
      } else {
        files[duEquivPath] = +m[1];
      }
    } else {
      // don't know how to suppress ps noise. have changed login script and it
      // is still running old one it seems.
      //console.log('unexpected line', line);
    }
  }
  // now fake testdir
  wo_node[testdir] = wo_total;
  w_node[testdir] = w_total;

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
getExpectedValuesWin(duOutput, findOutput, dirtreeRoot)
  .then(() => {
    console.log(duOutput, util.inspect(dirtreeRoot, {depth: 10}));
    walktree(dirtreeRoot);
  });


  function walktree(tree, branch = []) {
    for (const key of Object.keys(tree)) {
      branch.push(key);
      walktree(tree[key], branch);
      console.log(branch.join(p.sep), tree[key][BYTES])
      branch.pop();
    }
  }
