# action-walk

![commit-test](https://github.com/bmacnaughton/action-walk/workflows/commit-test/badge.svg)

Minimal utility to walk directory trees performing actions on each directory
entry. `action-walk` has no external production dependencies and has only one
strong opinion - don't presume anything about why the directory tree is being
walked. Oh, and another strong opinion - not supporting node versions prior to
v12.12.0.

No presumptions means that this does little more than walk the tree. There
are two options to facilitate implementing your code on top of `action-walk`.
If the boolean option `stat` is truthy `action-walk` will execute `fs.stat`
on the entry and pass that to you action handler. If the option `own` is
present `action-walk` will pass that to the action functions in a context
object.

### usage

`npm install action-walk`

### examples

```
//
// example to walk the directory tree, skipping node_modules, and
// totaling the number of bytes in each file.
//
const walk = require('@bmacnaughton/action-walk');

function dirAction (path, context) {
  const {dirent, stat, own} = context;
  if (own.skipDirs && own.skipDirs.indexOf(dirent.name) >= 0) {
    return 'skip';
  }
  own.total += stat.size;
}
function fileAction (path, context) {
  const {stat, own} = context;
  own.total += stat.size;
}

const own = {total: 0, skipDirs: ['node_modules']};
const options = {
  dirAction,
  fileAction,
  own,
  stat: true
};

walk('.', options)
  .then(() => {
    console.log('total bytes in "."', own.total);
  });

// executed in the action-walk package root it will print something like
// total bytes in "." 14778
```

see `test/basics.test.js` or `bin/walk.js` for other examples.

### api

`await walk(directory, options = {})`

options
- `dirAction` - called for each directory. If it returns `'skip'`, `action-walk` will not
recurse into the directory.
- `fileAction` - called for each file and, if `options.linkAction` is not set, each symbolic link.
- `linkAction` - called for each symbolic link when `options.linkAction` is set.
- `otherAction` - called when the entry is not a file, directory, or symbolic link.
- `stat` - if `'lstat'` call `fs.lstat` on the entry and add it to the action context as
the `stat` property. if otherwise truthy use `fs.stat`.
- `own` - add this to the action context. it is your context for the action functions.

It's possible to call `walk()` with no options but probably not useful unless
all you're wanting to do is seed the disk cache with directory entries. The
action functions are where task-specific work is done.

Each of the action function (`dirAction`, `fileAction`, `linkAction`, `otherAction`) is
called with two arguments:
- `filepath` for the entry starting with `directory`, e.g., if `directory` is `test` and
the entry is `basics.test.js` then `filepath` will be `test/basics.test.js`.
- `context` is an object:
```
{
  dirent, // the fs.Dirent object for the directory entry
  stat,   // if `options.stat`, the object returned by `fs.stat` or `fs.lstat`
  stack,  // the stack of directories above the current dirent item.
  own     // `options.own`, if provided.
}
```

`dirAction` is the only function with return value that matters. If
`dirAction` returns the string `'skip'` (either directly or via a
Promise) then `walk()` will not walk that branch of the directory tree.

All the action functions can return a promise if they need to perform
asynchronous work but only the value of `dirAction` is meaningful.

### todo

- add error handling
- add windows support
