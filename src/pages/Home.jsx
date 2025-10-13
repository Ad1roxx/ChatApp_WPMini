
import React from 'react';
import { Link } from 'react-router-dom';

const HomePage = () => {
  return (
    <div style={{ textAlign: 'center', marginTop: '50px' }}>
      <h1>Welcome to MentorConnect</h1>
      <p>Your platform for mentorship and learning.</p>
      <div>
        <Link to="/chats">
          <button style={{ marginRight: '10px' }}>Go to App</button>
        </Link>
        <Link to="/login">
          <button>Login</button>
        </Link>
      </div>
    </div>
  );
};

export default HomePage;
