import React from 'react';

export default function RecordsList({ records = [] }) {
  if (!records || records.length === 0) {
    return <div style={{ color: '#6b7280', fontSize: 13 }}>No records uploaded.</div>;
  }

  return (
    <div className="records-list">
      {records.map((r) => (
        <div key={r.id || r.storagePath || r.downloadURL} className="record-item" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0' }}>
          <div style={{ width: 36, height: 36, borderRadius: 6, background: '#eef2ff', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#1f2937', fontWeight: 700 }}>
            {r.filename ? r.filename.charAt(0).toUpperCase() : 'F'}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{r.filename || 'Attachment'}</div>
            <div style={{ fontSize: 12, color: '#6b7280' }}>{r.mimeType || ''}{r.size ? ` • ${Math.round(r.size/1024)} KB` : ''}</div>
          </div>
          {r.downloadURL ? (
            <a href={r.downloadURL} target="_blank" rel="noreferrer" className="btn small" style={{ padding: '6px 10px' }}>Open</a>
          ) : (
            <div style={{ color: '#9ca3af', fontSize: 12 }}>Unavailable</div>
          )}
        </div>
      ))}
    </div>
  );
}
