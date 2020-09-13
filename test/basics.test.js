const fsp = require('fs').promises;
const {execCommandLine} = require('./utilities/exec');
const walk = require('../action-walk');
const {expect} = require('chai');

const testdir = '.';
let testdirStat;
const duOutput = {
  wo_node: {},
  w_node: {},
}

describe('verify that action-walk works as expected', function () {
  // tests need to account for du counting the target directory itself
  // while walk treats that as a starting point and only counts the
  // contents of the directory.
  before(function getTestDirSize () {
    return fsp.stat(testdir)
      .then(s => {
        testdirStat = s;
      });
  })
  before(function getDuOutput () {
    // output is size-in-bytes <tab> path-starting-with-dir-name
    const p = [
      execCommandLine(`du -ab --exclude=node_modules ${testdir}`),
      execCommandLine(`du -ab ${testdir}`),
    ];
    return Promise.all(p)
      .then(r => {
        expect(r[0].stderr).equal('');
        expect(r[1].stderr).equal('');
        duOutput.wo_node = parseDuOutput(r[0].stdout);
        duOutput.w_node = parseDuOutput(r[1].stdout);
      });
  });

  it('should match du -ab output', function () {
    const own = {total: 0};
    const options = {dirAction, fileAction, own, stat: true};
    return walk(testdir, options)
      .then(() => {
        expect(own.total + testdirStat.size).equal(duOutput.w_node[testdir]);
      })
  });

  it('should match du -ab --exclude=node_modules', function () {
    const own = {total: 0, skipDirs: ['node_modules']};
    const options = {dirAction, fileAction, own, stat: true};
    return walk(testdir, options)
      .then(() => {
        expect(own.total + testdirStat.size).equal(duOutput.wo_node[testdir]);
      })
  });

  it('should execute recursively matching du -b --exclude=node_modules', function () {
    const own = {total: 0, dirTotals: {}, skipDirs: ['node_modules']};
    const options = {dirAction: daDirOnly, fileAction, own, stat: true};
    return walk(testdir, options)
      .then(() => {
        expect(own.total + testdirStat.size).equal(duOutput.wo_node[testdir]);
        for (const dir in own.dirTotals) {
          expect(own.dirTotals[dir]).equal(duOutput.w_node[`./${dir}`]);
        }
      });
  });

  it('should execute recursively matching du -b', function () {
    const own = {total: 0, dirTotals: {}, skipDirs: []};
    const options = {dirAction: daDirOnly, fileAction, own, stat: true};
    return walk(testdir, options)
      .then(() => {
        expect(own.total + testdirStat.size).equal(duOutput.w_node[testdir]);
        for (const dir in own.dirTotals) {
          expect(own.dirTotals[dir]).equal(duOutput.w_node[`./${dir}`]);
        }
      });
  });


});


//
// utilities
//
function dirAction (path, ctx) {
  const {dirent, stat, own} = ctx;
  if (own.skipDirs && own.skipDirs.indexOf(dirent.name) >= 0) {
    return 'skip';
  }
  own.total += stat.size;
}
function fileAction (path, ctx) {
  const {stat, own} = ctx;
  own.total += stat.size;
}

async function daDirOnly (path, ctx) {
  const {dirent, stat, own} = ctx;
  if (own.skipDirs && own.skipDirs.indexOf(dirent.name) >= 0) {
    return 'skip';
  }
  own.dirTotals[path] = 0;
  const newown = {total: 0, dirTotals: own.dirTotals};
  const options = {
    dirAction: daDirOnly,
    fileAction,
    own: newown,
    stat: true,
  };
  await walk(path, options);
  own.dirTotals[path] = newown.total + stat.size;
  own.total += newown.total + stat.size;

  // skip it because the recursive call counted the subtree.
  return 'skip';
}

function parseDuOutput (text) {
  const o = {};
  for (const m of text.matchAll(/(?<size>\d+)\s+(?<path>.+)/g)) {
    o[m.groups.path] = +m.groups.size;
  }
  return o;
}
