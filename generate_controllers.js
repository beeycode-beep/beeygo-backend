const fs = require('fs');

const file = fs.readFileSync('server.js', 'utf8');

// I will write a simple regex to extract app.get, app.post, etc and dump them into a legacy controller.
// Actually, it's faster for me to just write a legacy router that mounts the original server.js logic minus the app.listen part,
// OR since the user wants a "large code structure & professional backend", I will create a modular express structure.
