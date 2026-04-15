import { useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:4000';

const EXECUTION_MODES = {
  deterministic: {
    label: 'Deterministic Execution',
    endpoint: '/execute'
  },
  dynamic: {
    label: 'Dynamic Claude Execution',
    endpoint: '/execute-dynamic'
  }
};

export default function App() {
  const [task, setTask] = useState('Clean this CSV and standardize columns.');
  const [file, setFile] = useState(null);
  const [executionMode, setExecutionMode] = useState('deterministic');
  const [result, setResult] = useState('');
  const [logs, setLogs] = useState([]);
  const [metadata, setMetadata] = useState(null);
  const [artifacts, setArtifacts] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function runTask() {
    setLoading(true);
    setError('');

    try {
      const formData = new FormData();
      formData.append('task', task);
      if (file) formData.append('file', file);

      const endpoint = EXECUTION_MODES[executionMode].endpoint;
      const response = await fetch(`${API_BASE}${endpoint}`, {
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
      setArtifacts(data.artifacts || null);
    } catch (err) {
      setError(err.message || 'Unexpected error');
      setResult('');
      setLogs([]);
      setMetadata(null);
      setArtifacts(null);
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
        CSV Upload (optional for deterministic, required for dynamic demo)
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
        />
      </label>

      <label>
        Execution Mode
        <select value={executionMode} onChange={(e) => setExecutionMode(e.target.value)}>
          <option value="deterministic">Deterministic Execution</option>
          <option value="dynamic">Dynamic Claude Execution</option>
        </select>
      </label>

      <button onClick={runTask} disabled={loading}>
        {loading ? 'Running...' : `Run (${EXECUTION_MODES[executionMode].label})`}
      </button>

      {error && <p className="error">Error: {error}</p>}

      {metadata?.execution_mode && (
        <p>
          <strong>Execution mode:</strong> {metadata.execution_mode}
        </p>
      )}

      {typeof metadata?.iterations_used === 'number' && (
        <p>
          <strong>Iterations used:</strong> {metadata.iterations_used}
        </p>
      )}

      {typeof metadata?.validation_passed === 'boolean' && (
        <p>
          <strong>Validation status:</strong> {metadata.validation_passed ? 'Passed' : 'Failed'}
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

      {artifacts?.plan && (
        <section>
          <h2>Agent Plan</h2>
          <pre>{artifacts.plan}</pre>
        </section>
      )}

      {artifacts?.generated_code && (
        <section>
          <h2>Generated Code (Excerpt)</h2>
          <pre>{artifacts.generated_code}</pre>
        </section>
      )}

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
