Setup & run (PowerShell)
------------------------

1) Save your connection string & service account locally (do NOT commit):

   - Save the Firebase service account JSON somewhere safe, e.g.
     C:\secrets\mentorconnect-service-account.json

   - You already have your Atlas connection string (example):
     mongodb+srv://aditya1roxx_db_user:<PASSWORD>@mentor-connect1.3fve8.mongodb.net/?appName=mentor-connect1

2) Temporary (current PowerShell session) — set env vars:

```powershell
cd 'C:\Users\Aditya Dubey\Documents\mentorconnect\server'
# Use the full connection string you obtained from Atlas (include password).
$env:MONGODB_URI = '<PASTE_YOUR_FULL_MONGODB_URI_HERE>'
$env:GOOGLE_APPLICATION_CREDENTIALS = 'C:\secrets\mentorconnect-service-account.json'
```

3) OR create a local `.env` file in `server/` (recommended for dev):

 - Copy `server/.env.example` -> `server/.env`
 - Edit `server/.env` and replace the placeholders with your real values (do NOT commit `.env`).

4) Start the server:

```powershell
npm start
```

5) Verify server behavior:

 - In the server logs check for:
   - "Firebase Admin initialized" (service account loaded)
   - "Connected to MongoDB" (if `MONGODB_URI` is valid)
   - "Server listening at http://localhost:3001"

 - Quick API test from PowerShell (after server is running):
```powershell
# list announcements (GET)
Invoke-RestMethod -Uri 'http://localhost:3001/api/announcements'
```

Security notes
--------------
- Never paste the service account JSON or `.env` into public chat or commit it to Git.
- `server/.gitignore` (added) ignores `.env` and common JSON files; double-check your repo-level `.gitignore` too.