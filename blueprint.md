# MentorConnect Application Blueprint

## 1. Project Overview

**Purpose:** A real-time chat application designed to connect mentors and mentees.

---

## 2. Current State & Implemented Features (as of last session)

This document reflects the project state before implementing the backend.

*   **Framework:** React (initialized with Vite).
*   **Core Components:**
    *   `App.jsx`: Main application component with routing.
    *   `TopBar.jsx`: Navigation bar.
    *   `LoginPage.jsx` & `RegisterPage.jsx`: Basic user authentication forms.
    *   `ChatPage.jsx`: The main chat interface.
    *   `MentorChatsPage.jsx` & `AnnouncementsPage.jsx`: Placeholder pages for future features.
*   **Styling:** A custom CSS file (`App.css`) provides the application's styling, including a dark mode theme.
*   **Key Changes Made:**
    *   Removed the initial `ChatsPage.jsx` which was a static list of bots.
    *   Removed the "GIF Bot" functionality and Giphy API integration from `ChatPage.jsx` to simplify the core chat component.
    *   The application is currently a **front-end only prototype** using sample data for messages.

---

## 3. Plan for Backend Implementation

This section outlines the plan to build a fully functional backend, satisfying academic requirements while using modern, efficient technologies.

### 3.1. Chosen Architecture: Hybrid Approach

We will use a combination of Firebase services and a custom Node.js backend to leverage the strengths of both.

*   **Firebase's Role (Real-time Layer):**
    *   **Firebase Authentication:** Will be used to handle user sign-up, login, and session management securely.
    *   **Firebase Firestore:** Will be used as the real-time database for sending and receiving chat messages instantly.

*   **Node.js Server's Role (Application & Data Layer):**
    *   A custom backend will be built using **Node.js** and the **Express.js** framework.
    *   It will expose a **REST API** for the React client to consume.
    *   It will have its own **Database Integration** (e.g., MongoDB or PostgreSQL) to manage application-specific data.
    *   **Key Responsibilities:**
        *   Managing user profiles (e.g., display name, bio, role).
        *   Handling the logic for mentor/mentee relationships.
        *   Serving any other non-real-time data the application needs.

### 3.2. Immediate Next Steps

1.  **Create the Node.js Server:**
    *   Create a new `server/` directory in the project root.
    *   Initialize it with a `package.json` file, including `express` and `cors` as dependencies.
    *   Create the main server file (`server/index.js`).
2.  **Commit Changes:**
    *   Commit all existing front-end changes and the new `blueprint.md` file to the GitHub repository.
3.  **Continue on New Device:**
    *   Pull the latest changes from GitHub on the new device.
    *   Refer back to this blueprint to resume the backend implementation.
