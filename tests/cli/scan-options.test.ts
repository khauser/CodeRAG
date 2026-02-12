import { Command } from 'commander';

/**
 * Tests for the scan CLI command options
 * 
 * These tests verify that Commander.js parses the CLI options correctly,
 * particularly the --embeddings / --no-embeddings flag behavior.
 */
describe('Scan CLI Options', () => {
  let program: Command;
  let capturedOptions: any;

  beforeEach(() => {
    capturedOptions = null;
    
    // Create a fresh Command instance that mirrors scan.ts options
    program = new Command();
    program
      .argument('<project-path>', 'Path to the project directory to scan or Git URL')
      .option('-p, --project-id <id>', 'Project ID for multi-project separation')
      .option('-n, --project-name <name>', 'Project name')
      .option('-l, --languages <languages>', 'Comma-separated list of languages to scan')
      .option('-e, --exclude <paths>', 'Comma-separated list of paths to exclude', 'node_modules,dist,build')
      .option('--include-tests', 'Include test files in the scan', false)
      .option('--clear-graph', 'Clear existing graph data for this project before scanning', false)
      .option('--clear-all', 'Clear ALL graph data (all projects) before scanning', false)
      .option('--analyze', 'Run quality analysis after scanning', false)
      .option('--output-report', 'Generate and save a scan report', false)
      .option('--validate-only', 'Only validate the project structure without scanning', false)
      .option('--branch <branch>', 'Git branch to scan (for remote repositories)', 'main')
      .option('--no-cleanup', 'Keep temporary files after scanning (for debugging)')
      .option('--use-cache', 'Enable repository caching for faster subsequent scans', false)
      .option('--clear-cache', 'Clear git repository cache before scanning', false)
      // When only --no-<flag> is defined, Commander.js sets flag to true by default
      // and --no-<flag> sets it to false
      .option('--no-embeddings', 'Skip automatic embedding generation after scan')
      .option('-v, --verbose', 'Show detailed progress information', false)
      .action((projectPath: string, options) => {
        capturedOptions = options;
      });
    
    // Prevent Commander from exiting on errors
    program.exitOverride();
  });

  describe('--embeddings / --no-embeddings flag', () => {
    it('should have embeddings as true by default when no flag is provided', () => {
      program.parse(['node', 'test', './my-project']);
      
      expect(capturedOptions).toBeDefined();
      // When only --no-embeddings is defined, Commander.js sets embeddings to true by default
      expect(capturedOptions.embeddings).toBe(true);
      // Default behavior: should run embeddings
      expect(capturedOptions.embeddings !== false).toBe(true);
    });

    it('should set embeddings to false when --no-embeddings is provided', () => {
      program.parse(['node', 'test', './my-project', '--no-embeddings']);
      
      expect(capturedOptions).toBeDefined();
      expect(capturedOptions.embeddings).toBe(false);
      // Should NOT run embeddings
      expect(capturedOptions.embeddings !== false).toBe(false);
    });

    it('should allow --no-embeddings with other options', () => {
      program.parse(['node', 'test', './my-project', '--no-embeddings', '--verbose', '--analyze']);
      
      expect(capturedOptions).toBeDefined();
      expect(capturedOptions.embeddings).toBe(false);
      expect(capturedOptions.verbose).toBe(true);
      expect(capturedOptions.analyze).toBe(true);
    });

    it('should allow --no-embeddings at any position in arguments', () => {
      program.parse(['node', 'test', '--no-embeddings', './my-project', '--verbose']);
      
      expect(capturedOptions).toBeDefined();
      expect(capturedOptions.embeddings).toBe(false);
      expect(capturedOptions.verbose).toBe(true);
    });
  });

  describe('other boolean options', () => {
    it('should handle --include-tests flag', () => {
      program.parse(['node', 'test', './my-project', '--include-tests']);
      
      expect(capturedOptions.includeTests).toBe(true);
    });

    it('should handle --clear-graph flag', () => {
      program.parse(['node', 'test', './my-project', '--clear-graph']);
      
      expect(capturedOptions.clearGraph).toBe(true);
    });

    it('should handle --analyze flag', () => {
      program.parse(['node', 'test', './my-project', '--analyze']);
      
      expect(capturedOptions.analyze).toBe(true);
    });

    it('should handle --no-cleanup flag', () => {
      program.parse(['node', 'test', './my-project', '--no-cleanup']);
      
      expect(capturedOptions.cleanup).toBe(false);
    });
  });

  describe('option combinations', () => {
    it('should handle multiple flags together', () => {
      program.parse([
        'node', 'test', './my-project',
        '--no-embeddings',
        '--analyze',
        '--verbose',
        '--include-tests'
      ]);
      
      expect(capturedOptions.embeddings).toBe(false);
      expect(capturedOptions.analyze).toBe(true);
      expect(capturedOptions.verbose).toBe(true);
      expect(capturedOptions.includeTests).toBe(true);
    });

    it('should handle --no-embeddings with --clear-graph', () => {
      program.parse(['node', 'test', './my-project', '--no-embeddings', '--clear-graph']);
      
      expect(capturedOptions.embeddings).toBe(false);
      expect(capturedOptions.clearGraph).toBe(true);
    });
  });

  describe('string options', () => {
    it('should handle --project-id option', () => {
      program.parse(['node', 'test', './my-project', '-p', 'my-custom-id']);
      
      expect(capturedOptions.projectId).toBe('my-custom-id');
    });

    it('should handle --languages option', () => {
      program.parse(['node', 'test', './my-project', '-l', 'typescript,javascript']);
      
      expect(capturedOptions.languages).toBe('typescript,javascript');
    });

    it('should handle --branch option', () => {
      program.parse(['node', 'test', './my-project', '--branch', 'develop']);
      
      expect(capturedOptions.branch).toBe('develop');
    });

    it('should use default value for --exclude when not specified', () => {
      program.parse(['node', 'test', './my-project']);
      
      expect(capturedOptions.exclude).toBe('node_modules,dist,build');
    });

    it('should override default --exclude when specified', () => {
      program.parse(['node', 'test', './my-project', '-e', 'vendor,tmp']);
      
      expect(capturedOptions.exclude).toBe('vendor,tmp');
    });
  });
});
