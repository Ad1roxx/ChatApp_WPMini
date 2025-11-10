require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const admin = require('firebase-admin');
const path = require('path');

const app = express();
const port = process.env.PORT || 3001;

// Track all SSE clients and state
const sseClients = new Set();
const chatClients = new Map(); // chatId -> Set of clients
const activeUsers = new Map(); // userId -> Set of chatIds they're viewing
const typingUsers = new Map(); // chatId -> Set of userIds typing

// Enable CORS with credentials
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json());

// Initialize Firebase Admin SDK if service account provided
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  try {
    const serviceAccount = require(path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS));
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log('Firebase Admin initialized');
  } catch (err) {
    console.error('Failed to initialize Firebase Admin:', err);
  }
} else {
  console.warn('GOOGLE_APPLICATION_CREDENTIALS not set — protected endpoints disabled');
}

// Connect to MongoDB (optional: if MONGODB_URI not set, server falls back to in-memory behavior)
const mongoUri = process.env.MONGODB_URI;
if (mongoUri) {
  mongoose.connect(mongoUri, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log('Connected to MongoDB'))
    .catch((err) => console.error('MongoDB connection error:', err));
} else {
  console.warn('MONGODB_URI not set — announcements will use in-memory fallback');
}

// Announcement model (used when Mongo is connected)
const announcementSchema = new mongoose.Schema({
  text: { type: String, required: true },
  time: { type: String },
  authorId: { type: String },
  authorDisplayName: { type: String },
  createdAt: { type: Date, default: Date.now }
});
const Announcement = mongoose.models.Announcement || mongoose.model('Announcement', announcementSchema);

// Simple in-memory fallback announcements
let fallbackAnnouncements = [
  { text: 'Welcome to MentorConnect!', time: '10:00 AM', authorId: null, authorDisplayName: null },
  { text: 'Please be respectful to your mentors and peers.', time: '11:30 AM', authorId: null, authorDisplayName: null },
];

// Middleware: verify Firebase ID token and role 'mentor'
async function verifyMentor(req, res, next) {
  if (!admin.apps.length) return res.status(500).json({ error: 'Server not configured to verify tokens' });

  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });
  const idToken = authHeader.split('Bearer ')[1];

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const userDoc = await admin.firestore().doc(`users/${decoded.uid}`).get();
    const userData = userDoc.exists ? userDoc.data() : null;
    if (userData && userData.role === 'mentor') {
      req.user = decoded;
      return next();
    }
    return res.status(403).json({ error: 'Insufficient permissions' });
  } catch (err) {
    console.error('Token verification failed', err);
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// GET announcements
app.get('/api/announcements', async (req, res) => {
  try {
    if (mongoose.connection.readyState === 1) {
      const items = await Announcement.find().sort({ createdAt: 1 }).limit(100).lean();
      return res.json(items.map(it => ({ 
        text: it.text, 
        time: it.time || '', 
        authorId: it.authorId || null, 
        authorDisplayName: it.authorDisplayName || null, 
        _id: it._id 
      })));
    }
    return res.json([...fallbackAnnouncements].reverse());
  } catch (err) {
    console.error('Failed to fetch announcements:', err);
    res.status(500).json({ error: 'Failed to fetch announcements' });
  }
});

// POST update activity status
app.post('/api/activity/update', (req, res) => {
  const { userId, chatId, isActive } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  if (isActive) {
    if (!activeUsers.has(userId)) activeUsers.set(userId, new Set());
    if (chatId) activeUsers.get(userId).add(chatId);
  } else {
    if (chatId && activeUsers.has(userId)) activeUsers.get(userId).delete(chatId);
    if (activeUsers.has(userId) && activeUsers.get(userId).size === 0) activeUsers.delete(userId);
  }

  // Notify all clients about the activity update
  const eventData = JSON.stringify({ userId, chatId, isActive });
  for (const client of sseClients) {
    client.write(`event: activity\n`);
    client.write(`data: ${eventData}\n\n`);
  }

  res.json({ success: true });
});

// POST update typing status
app.post('/api/typing/update', (req, res) => {
  const { userId, chatId, isTyping } = req.body;
  if (!userId || !chatId) return res.status(400).json({ error: 'Missing userId or chatId' });

  try {
    if (isTyping) {
      if (!typingUsers.has(chatId)) typingUsers.set(chatId, new Set());
      typingUsers.get(chatId).add(userId);
    } else {
      if (typingUsers.has(chatId)) {
        typingUsers.get(chatId).delete(userId);
        if (typingUsers.get(chatId).size === 0) typingUsers.delete(chatId);
      }
    }

    // Notify all clients about the typing update
    const eventData = JSON.stringify({ userId, chatId, isTyping });
    
    // First notify specific chat clients
    if (chatClients.has(chatId)) {
      for (const client of chatClients.get(chatId)) {
        client.write(`event: typing\n`);
        client.write(`data: ${eventData}\n\n`);
      }
    }
    
    // Then notify general SSE clients
    for (const client of sseClients) {
      client.write(`event: typing\n`);
      client.write(`data: ${eventData}\n\n`);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating typing status:', error);
    res.status(500).json({ error: 'Failed to update typing status' });
  }
});

// Server-Sent Events endpoint for live announcements
app.get('/api/announcements/live', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write('event: connected\n');
  res.write('data: connected\n\n');

  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// POST new announcement (mentor-only)
app.post('/api/announcements', verifyMentor, async (req, res) => {
  try {
    const { text, time } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Text required' });

    if (mongoose.connection.readyState === 1) {
      let authorDisplayName = null;
      try {
        if (admin.apps.length) {
          const udoc = await admin.firestore().doc(`users/${req.user.uid}`).get();
          if (udoc.exists) {
            const ud = udoc.data();
            authorDisplayName = ud && ud.displayName ? ud.displayName : null;
          }
        }
      } catch (e) {
        console.warn('Could not read author displayName from Firestore', e);
      }

      const a = new Announcement({
        text: text.trim(),
        time: time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        authorId: req.user.uid,
        authorDisplayName: authorDisplayName || null,
      });
      await a.save();

      const announcement = { 
        text: a.text, 
        time: a.time, 
        _id: a._id, 
        authorId: a.authorId, 
        authorDisplayName: a.authorDisplayName 
      };

      const payload = `event: announcement\ndata: ${JSON.stringify(announcement)}\n\n`;
      for (const client of sseClients) {
        try {
          client.write(payload);
        } catch (e) {
          sseClients.delete(client);
        }
      }

      return res.status(201).json(announcement);
    }

    const newAnn = { 
      text: text.trim(), 
      time: time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) 
    };
    fallbackAnnouncements.push(newAnn);

    const payload = `event: announcement\ndata: ${JSON.stringify(newAnn)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(payload);
      } catch (e) {
        sseClients.delete(client);
      }
    }

    return res.status(201).json(newAnn);
  } catch (err) {
    console.error('Failed to create announcement:', err);
    res.status(500).json({ error: 'Failed to create announcement' });
  }
});

// For live chat messages
app.get('/api/chats/:chatId/messages/live', (req, res) => {
  const chatId = req.params.chatId;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  
  // Send initial connection event
  res.write('event: connected\ndata: {}\n\n');
  
  if (!chatClients.has(chatId)) {
    chatClients.set(chatId, new Set());
  }
  chatClients.get(chatId).add(res);
  
  const unsubscribe = admin.firestore()
    .collection('chats').doc(chatId)
    .collection('messages')
    .orderBy('createdAt', 'desc')
    .limit(1)
    .onSnapshot(snapshot => {
      snapshot.docChanges().forEach(change => {
        if (change.type === 'added') {
          const message = { id: change.doc.id, ...change.doc.data() };
          const data = JSON.stringify(message);
          for (const client of chatClients.get(chatId)) {
            client.write(`event: message\ndata: ${data}\n\n`);
          }
        }
      });
    }, error => {
      console.error(`Chat ${chatId} message listener error:`, error);
    });
    
  req.on('close', () => {
    unsubscribe();
    chatClients.get(chatId)?.delete(res);
    if (chatClients.get(chatId)?.size === 0) {
      chatClients.delete(chatId);
    }
  });
});

// For live chat updates (new chats)
app.get('/api/chats/live', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  res.write('event: connected\ndata: {}\n\n');
  
  sseClients.add(res);
  
  const unsubscribe = admin.firestore()
    .collection('chats')
    .onSnapshot(snapshot => {
      snapshot.docChanges().forEach(change => {
        if (change.type === 'added') {
          const chat = { id: change.doc.id, ...change.doc.data() };
          res.write(`event: chat\ndata: ${JSON.stringify(chat)}\n\n`);
        }
      });
    }, error => {
      console.error('Chats listener error:', error);
    });
  
  // Send initial active users and typing status
  for (const [userId, chatIds] of activeUsers.entries()) {
    chatIds.forEach(chatId => {
      res.write(`event: activity\ndata: ${JSON.stringify({ userId, chatId, isActive: true })}\n\n`);
    });
  }

  for (const [chatId, users] of typingUsers.entries()) {
    users.forEach(userId => {
      res.write(`event: typing\ndata: ${JSON.stringify({ userId, chatId, isTyping: true })}\n\n`);
    });
  }
  
  req.on('close', () => {
    unsubscribe();
    sseClients.delete(res);
  });
});

// For marking messages as read
app.post('/api/chats/:chatId/markAsRead', async (req, res) => {
  const chatId = req.params.chatId;
  res.json({ success: true });
});

app.listen(port, () => console.log(`Server listening at http://localhost:${port}`));