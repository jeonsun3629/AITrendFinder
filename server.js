const express = require('express');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;

// Static files
app.use(express.static(path.join(__dirname, '/')));

// All requests
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
}); 