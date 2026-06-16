module.exports = {
  apps: [{
    name: 'usa-backend',
    script: './lib/server.js',
    cwd: '/home/ubuntu/app/functions',
    env: {
      NODE_ENV: 'production',
    }
  }]
}
