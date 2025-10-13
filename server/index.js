const express = require('express');
const cors = require('cors');

const app = express();
const port = 3001;

// Correct CORS configuration
app.use(cors({
  origin: '*', // Allow all origins
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));

// Correct middleware order
app.use(express.json());

let announcements = [
  { text: 'Welcome to MentorConnect!', time: '10:00 AM' },
  { text: 'Please be respectful to your mentors and peers.', time: '11:30 AM' },
];

app.get('/api/announcements', (req, res) => {
  res.json(announcements);
});

app.post('/api/announcements', (req, res) => {
  const newAnnouncement = req.body;
  announcements.push(newAnnouncement);
  res.status(201).json(newAnnouncement);
});

app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});
