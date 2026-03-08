#!/usr/bin/env node

/**
 * Test runner for comprehensive enhanced PR Autopilot tests
 * This script runs all the test suites and provides detailed reporting
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ANSI color codes for output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSection(title) {
  log(`\n═══════════════════════════════════════════════════════════════`, 'cyan');
  log(`  ${title}`, 'bright');
  log(`═══════════════════════════════════════════════════════════════`, 'cyan');
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'pipe',
      shell: true,
      ...options
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
}

async function runTestSuite(testFile, description) {
  logSection(`Running: ${description}`);
  log(`File: ${testFile}`, 'blue');
  
  try {
    const bunPath = 'C:\\Users\\ceclabs\\AppData\\Roaming\\npm\\bun';
    const { code, stdout, stderr } = await runCommand(bunPath, ['test', testFile]);
    
    if (code === 0) {
      log('✅ PASSED', 'green');
      
      // Extract test results
      const lines = stdout.split('\n');
      const testResults = [];
      let currentTest = null;
      
      for (const line of lines) {
        if (line.includes('✓') || line.includes('should')) {
          currentTest = line.trim();
          testResults.push({ name: currentTest, status: 'PASS' });
        } else if (line.includes('✗') || line.includes('failed')) {
          if (currentTest) {
            testResults[testResults.length - 1].status = 'FAIL';
          }
        }
      }
      
      return { success: true, results: testResults, output: stdout };
    } else {
      log('❌ FAILED', 'red');
      log(`Exit code: ${code}`, 'yellow');
      if (stderr) {
        log('Error output:', 'red');
        log(stderr, 'red');
      }
      return { success: false, output: stdout, error: stderr };
    }
  } catch (error) {
    log(`❌ ERROR: ${error.message}`, 'red');
    return { success: false, error: error.message };
  }
}

async function runAllTests() {
  const startTime = Date.now();
  
  logSection('🧪 Enhanced PR Autopilot - Comprehensive Test Suite');
  log(`Started at: ${new Date().toLocaleString()}`, 'blue');
  
  const testSuites = [
    {
      file: 'tests/diff-validation.test.ts',
      description: 'Diff Validation - Real World Examples'
    },
    {
      file: 'tests/integration.test.ts', 
      description: 'Integration Tests - End-to-End Scenarios'
    },
    {
      file: 'tests/comprehensive-enhanced.test.ts',
      description: 'Enhanced Components - Full System Tests'
    }
  ];

  const results = {
    total: 0,
    passed: 0,
    failed: 0,
    suites: []
  };

  for (const suite of testSuites) {
    const result = await runTestSuite(suite.file, suite.description);
    
    results.suites.push({
      name: suite.description,
      file: suite.file,
      ...result
    });

    if (result.success) {
      results.passed++;
      log(`Suite completed successfully`, 'green');
    } else {
      results.failed++;
      log(`Suite failed`, 'red');
    }
    
    results.total++;
  }

  const duration = Date.now() - startTime;
  
  // Final Report
  logSection('📊 Test Results Summary');
  log(`Total Suites: ${results.total}`, 'bright');
  log(`Passed: ${results.passed}`, 'green');
  log(`Failed: ${results.failed}`, results.failed > 0 ? 'red' : 'green');
  log(`Duration: ${(duration / 1000).toFixed(2)}s`, 'blue');
  
  if (results.failed > 0) {
    log('\n❌ Failed Suites:', 'red');
    for (const suite of results.suites) {
      if (!suite.success) {
        log(`  - ${suite.name}`, 'red');
        if (suite.error) {
          log(`    Error: ${suite.error}`, 'yellow');
        }
      }
    }
  }

  // Detailed results for each suite
  for (const suite of results.suites) {
    logSection(`📋 ${suite.name}`);
    
    if (suite.results && suite.results.length > 0) {
      const passed = suite.results.filter(r => r.status === 'PASS').length;
      const failed = suite.results.filter(r => r.status === 'FAIL').length;
      
      log(`Tests: ${passed} passed, ${failed} failed`, failed > 0 ? 'yellow' : 'green');
      
      if (failed > 0) {
        log('Failed tests:', 'red');
        suite.results.filter(r => r.status === 'FAIL').forEach(test => {
          log(`  ❌ ${test.name}`, 'red');
        });
      }
    }
    
    if (suite.output && suite.output.includes('✓')) {
      log('Sample output:', 'cyan');
      const sampleLines = suite.output.split('\n').filter(line => line.includes('✓')).slice(0, 5);
      sampleLines.forEach(line => log(`  ${line}`, 'green'));
    }
  }

  // Exit with appropriate code
  process.exit(results.failed > 0 ? 1 : 0);
}

// Handle process termination
process.on('SIGINT', () => {
  log('\n🛑 Test execution interrupted', 'yellow');
  process.exit(1);
});

process.on('SIGTERM', () => {
  log('\n🛑 Test execution terminated', 'yellow');
  process.exit(1);
});

// Run the tests
if (require.main === module) {
  runAllTests().catch(error => {
    log(`💥 Fatal error: ${error.message}`, 'red');
    process.exit(1);
  });
}

module.exports = { runAllTests, runTestSuite };
