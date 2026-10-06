#!/usr/bin/env node
'use strict';

const { run } = require('../src/cli');

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code || 0;
  })
  .catch((err) => {
    process.stderr.write(`예기치 못한 오류: ${(err && err.stack) || err}\n`);
    process.exitCode = 1;
  });
