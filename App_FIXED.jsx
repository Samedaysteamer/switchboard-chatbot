
import React, { useState } from 'react';

export default function App() {
  const [service, setService] = useState('Moving');
  const [arrival, setArrival] = useState('');
  const [summary, setSummary] = useState('');
  const [salesRep, setSalesRep] = useState('');
  const [link, setLink] = useState('');

  const generateLink = () => {
    const jotformBase = 'https://form.jotform.com/251537865180159';
    const params = new URLSearchParams();

    params.set('summary', summary.trim().replace(/\s+/g, '+'));
    params.set('arrival', arrival.trim().replace(/\s+/g, '+'));
    params.set('service', service);
    params.set('rep', salesRep.trim().replace(/\s+/g, '+'));

    const fullLink = `${jotformBase}?${params.toString()}`;
    setLink(fullLink);
  };

  return (
    <div style={{ padding: '2rem', fontFamily: 'Arial' }}>
      <h1>📦 Booking Link Generator</h1>

      <label>Service Type:</label><br />
      <select value={service} onChange={(e) => setService(e.target.value)}>
        <option value="Carpet Cleaning">Carpet Cleaning</option>
        <option value="Moving">Moving</option>
        <option value="Upholstery">Upholstery</option>
        <option value="Duct Cleaning">Duct Cleaning</option>
      </select><br /><br />

      <label>Arrival Window:</label><br />
      <input value={arrival} onChange={(e) => setArrival(e.target.value)} placeholder="e.g. 7–9 AM" /><br /><br />

      <label>Quote Summary:</label><br />
      <textarea value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="e.g. $300 First 2 Hours..."></textarea><br /><br />

      <label>Sales Rep Name (optional):</label><br />
      <input value={salesRep} onChange={(e) => setSalesRep(e.target.value)} /><br /><br />

      <button onClick={generateLink} style={{ padding: '10px 20px' }}>
        Generate Booking Link
      </button>

      {link && (
        <div style={{ marginTop: '2rem' }}>
          <h3>📎 Generated Link:</h3>
          <a href={link} target="_blank" rel="noopener noreferrer">{link}</a>
        </div>
      )}
    </div>
  );
}
