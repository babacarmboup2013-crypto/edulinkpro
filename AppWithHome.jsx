import React from 'react';
import HomePage from './HomePage.jsx';

export default function AppWithHome() {
  return <HomePage onEnter={() => { window.location.href = `${import.meta.env.BASE_URL}connect.html`; }} />;
}
