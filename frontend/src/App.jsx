import { useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:4000';

export default function App() {
  const [task, setTask] = useState('Clean this CSV and standardize columns.');
  const [file, setFile] = useState(null);
  const [result, setResult] = useState('');
  const [logs, setLogs] = useState([]);
  const [metadata, setMetadata] = useState(null);
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
        throw new Error(data.details ? `${data.error} ${data.details}` : data.error || 'Request failed');
      }

      setResult(data.result || '');
      setLogs(Array.isArray(data.logs) ? data.logs : []);
      setMetadata(data.metadata || null);
    } catch (err) {
      setError(err.message || 'Unexpected error');
      setResult('');
      setLogs([]);
      setMetadata(null);
    } finally {
      setLoading(false);
    }
  }

  const warnings = Array.isArray(metadata?.warnings) ? metadata.warnings : [];

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

      {metadata?.execution_mode && (
        <p>
          <strong>Execution mode:</strong> {metadata.execution_mode}
        </p>
      )}

      {metadata?.fallback_plan_used && (
        <p>
          <em>Note: Claude planning was unavailable, so a backend fallback plan was used.</em>
        </p>
      )}

      <section>
        <h2>Execution Steps</h2>
        {logs.length === 0 ? (
          <p>No logs yet.</p>
        ) : (
          <ol className="step-list">
            {logs.map((log, idx) => (
              <li className="step-item" key={`${idx}-${log}`}>
                <span className="step-dot" aria-hidden="true">
                  {idx + 1}
                </span>
                <span>{log}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section>
        <h2>Output</h2>
        <pre>{result || 'No output yet.'}</pre>
      </section>

      <section>
        <h2>Metadata</h2>
        {metadata ? <pre>{JSON.stringify(metadata, null, 2)}</pre> : <p>No metadata yet.</p>}
      </section>

      {warnings.length > 0 && (
        <section>
          <h2>Warnings</h2>
          <ul>
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
