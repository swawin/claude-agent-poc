import { useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:4000';

export default function App() {
  const [task, setTask] = useState('Clean this CSV and standardize columns.');
  const [file, setFile] = useState(null);
  const [result, setResult] = useState('');
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function runTask() {
    setLoading(true);
    setError('');

    try {
      const formData = new FormData();
      formData.append('task', task);
      if (file) formData.append('file', file);

      const response = await fetch(`${API_BASE}/execute`, {
        method: 'POST',
        body: formData
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Request failed');
      }

      setResult(data.result || '');
      setLogs(Array.isArray(data.logs) ? data.logs : []);
    } catch (err) {
      setError(err.message || 'Unexpected error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="container">
      <h1>Claude Execution Tool Demo</h1>

      <label>
        Task
        <input
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="Describe what to do with the CSV"
        />
      </label>

      <label>
        CSV Upload (optional)
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
        />
      </label>

      <button onClick={runTask} disabled={loading}>
        {loading ? 'Running...' : 'Run Task'}
      </button>

      {error && <p className="error">Error: {error}</p>}

      <section>
        <h2>Output</h2>
        <pre>{result || 'No output yet.'}</pre>
      </section>

      <section>
        <h2>Logs</h2>
        {logs.length === 0 ? (
          <p>No logs yet.</p>
        ) : (
          <ol>
            {logs.map((log, idx) => (
              <li key={`${idx}-${log}`}>{log}</li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}
