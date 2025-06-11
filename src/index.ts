#!/usr/bin/env node

import { Command } from 'commander';
import { deployCommand } from './commands/deploy.js';

const program = new Command();

program
  .name('arasaka')
  .description('Command line tools for deploying to Arasaka server')
  .version('1.0.0');

program
  .command('deploy')
  .description('Deploy application to TrueNAS server')
  .option('-c, --config <file>', 'Configuration file', 'arasaka.yaml')
  .option('-t, --tag <tag>', 'Image tag', 'latest')
  .option('--dry-run', 'Show what would be deployed without actually deploying')
  .action(deployCommand);

program.parse(); 