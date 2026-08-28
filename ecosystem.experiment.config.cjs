// Governed vs. ungoverned e3d-corp <-> e3d-trade experiment (2026-08-27, 2-week window, BTC-hold benchmark).
// CONTROL: no capital_mandate ever submitted. TREATMENT: receives the approved active mandate.
// Both are fresh $100k paper portfolios, fully isolated from the primary e3d-trade instance.
module.exports = {
  apps: [
    {
      name: 'e3d-trade-control-dashboard',
      script: 'node',
      args: 'server.js',
      cwd: '/Users/mini/e3d-trade-control',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: { PORT: '3001' },
      error_file: '/Users/mini/e3d-trade-control/logs/dashboard-error.log',
      out_file: '/Users/mini/e3d-trade-control/logs/dashboard-out.log',
      time: true
    },
    {
      name: 'e3d-trade-control-pipeline',
      script: 'node',
      args: 'pipeline.js --loop',
      cwd: '/Users/mini/e3d-trade-control',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      error_file: '/Users/mini/e3d-trade-control/logs/pipeline-error.log',
      out_file: '/Users/mini/e3d-trade-control/logs/pipeline-out.log',
      time: true
    },
    {
      name: 'e3d-trade-treatment-dashboard',
      script: 'node',
      args: 'server.js',
      cwd: '/Users/mini/e3d-trade-treatment',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: { PORT: '3002' },
      error_file: '/Users/mini/e3d-trade-treatment/logs/dashboard-error.log',
      out_file: '/Users/mini/e3d-trade-treatment/logs/dashboard-out.log',
      time: true
    },
    {
      name: 'e3d-trade-treatment-pipeline',
      script: 'node',
      args: 'pipeline.js --loop',
      cwd: '/Users/mini/e3d-trade-treatment',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      error_file: '/Users/mini/e3d-trade-treatment/logs/pipeline-error.log',
      out_file: '/Users/mini/e3d-trade-treatment/logs/pipeline-out.log',
      time: true
    }
  ]
};
