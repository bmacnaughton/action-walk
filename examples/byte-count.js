'use strict';

//
// example to walk the directory tree, skipping node_modules, and
// totaling the number of bytes in each file.
//
const walk = require('../action-walk.js');

function dirAction(path, context) {
  const { dirent, stat, own } = context;
  if (own.skipDirs && own.skipDirs.indexOf(dirent.name) >= 0) {
    return 'skip';
  }
  own.total += stat.size;
}
function fileAction(path, context) {
  const { stat, own } = context;
  own.total += stat.size;
}

const own = { total: 0, skipDirs: ['node_modules'] };
const options = {
  dirAction,
  fileAction,
  own,
  stat: true
};

walk('.', options)
  .then(() => {
    console.log('total bytes in "." (excluding node_modules)', own.total);
  });
