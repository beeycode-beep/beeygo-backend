const fs = require('fs');

let content = fs.readFileSync('server.js', 'utf8');

// Replace auth routes
content = content.replace(/\/\/ ----------------------------------------------------\n\/\/ Admin Auth Routes[\s\S]*?(?=\/\/ ----------------------------------------------------\n\/\/ Mining & User Routes)/, '// [AUTH ROUTES EXTRACTED]\n\n');

fs.writeFileSync('server.new.js', content);
