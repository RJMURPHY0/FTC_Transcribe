import { useState, useRef } from 'react'
import './index.css'

function App() {
  const [isRecording, setIsRecording] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [results, setResults] = useState(null)
  const [error, setError] = useState('')

  const mediaRecorderRef = useRef(null)
  const audioChunksRef = useRef([])

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mediaRecorder = new MediaRecorder(stream)
      mediaRecorderRef.current = mediaRecorder
      audioChunksRef.current = []

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data)
        }
      }

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' })
        await sendAudioToBackend(audioBlob)
      }

      mediaRecorder.start()
      setIsRecording(true)
      setError('')
      setResults(null)
    } catch (err) {
      console.error("Error accessing microphone:", err)
      setError("Please allow microphone access to record.")
    }
  }

  const pauseRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.pause()
      setIsPaused(true)
    }
  }

  const resumeRecording = () => {
    if (mediaRecorderRef.current && isRecording && isPaused) {
      mediaRecorderRef.current.resume()
      setIsPaused(false)
    }
  }

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop()
      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop())
      setIsRecording(false)
      setIsPaused(false)
    }
  }

  const handleRecordClick = () => {
    if (isRecording) {
      stopRecording()
    } else {
      startRecording()
    }
  }

  const sendAudioToBackend = async (audioBlob) => {
    setIsProcessing(true)
    const formData = new FormData()
    formData.append('file', audioBlob, 'recording.webm')

    try {
      const response = await fetch('http://localhost:8000/api/transcribe', {
        method: 'POST',
        body: formData,
      })

      if (!response.ok) {
        throw new Error(`Server error: ${response.statusText}`)
      }

      const data = await response.json()
      setResults(data)
    } catch (err) {
      console.error("Error sending audio:", err)
      setError("Failed to process the audio. Is the backend running?")
    } finally {
      setIsProcessing(false)
    }
  }

  return (
    <>
      {/* LEFT SIDEBAR */}
      <div className="sidebar">
        <div className="logo-container" style={{ display: 'flex', alignItems: 'center' }}>
          <img src="/logo.png" alt="FTC Transcribe Logo" style={{ height: '40px', objectFit: 'contain' }} />
        </div>
        <div className="nav-menu">
          <div className="nav-item active">
             <span className="icon">🏠</span> Home
          </div>
          <div className="nav-item">
             <span className="icon">📹</span> Meetings
          </div>
          <div className="nav-item">
             <span className="icon">📈</span> Meeting Status
          </div>
          <div className="nav-item">
             <span className="icon">☁️</span> Uploads
          </div>
          <div style={{ margin: '15px 0', borderBottom: '1px solid var(--border-color)' }}></div>
          <div className="nav-item">
             <span className="icon">⚙️</span> Settings
          </div>
        </div>
      </div>

      {/* MAIN CONTENT */}
      <div className="main-content">
        <div className="header">
          <input type="text" className="search-bar" placeholder="Search by title or keyword" />
          <div className="header-actions">
            <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Free meetings</span>
            <button className="btn-upgrade">Upgrade</button>
            <button className="btn-primary" onClick={handleRecordClick} disabled={isProcessing}>
               {isRecording ? '⏹ Stop' : '▶ Capture'}
            </button>
          </div>
        </div>

        <div className="dashboard-body">
          <div className="greeting-banner">
            <h1>Good Afternoon, Ryan</h1>
            <p style={{ color: 'var(--text-muted)' }}>Share Feedback</p>
          </div>

          <div className="stats-row">
            <div className="stat-card">
              ✅ 0 New Tasks
              <span className="stat-val">LAST 7 DAYS</span>
            </div>
            <div className="stat-card">
              ✨ 0 AI Skills
            </div>
            <div className="stat-card">
              📅 0 Meeting Preps
            </div>
          </div>

          <div className="record-section">
            <h2>Live Capture</h2>
            <div className="record-controls">
              <button
                className={`record-btn-large ${isRecording ? 'recording' : ''}`}
                onClick={handleRecordClick}
                disabled={isProcessing}
              >
                {isRecording ? '⏹' : '🎤'}
              </button>
              {isRecording && (
                <div className="pause-resume-group">
                  {isPaused ? (
                    <button
                      className="btn-control btn-resume"
                      onClick={resumeRecording}
                      title="Resume recording"
                    >
                      ▶ Resume
                    </button>
                  ) : (
                    <button
                      className="btn-control btn-pause"
                      onClick={pauseRecording}
                      title="Pause recording"
                    >
                      ⏸ Pause
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="status-msg">
              {isRecording ? (
                isPaused ?
                  "Recording paused. Click Resume to continue or Stop to finish." :
                  "Recording active. Click Pause to pause or Stop to finish."
              ) :
               isProcessing ? "Transcribing & summarizing..." :
               "Click the microphone to record a meeting"}
            </div>
            {error && <div style={{ color: '#ef4444', marginTop: '10px' }}>{error}</div>}
          </div>

          {results && !isProcessing && (
            <div className="results-container">
              <div className="result-card">
                <h3>Meeting Summary</h3>
                <p>{results.summary}</p>
              </div>
              <div className="result-card">
                <h3>Action Items</h3>
                {results.actions.length > 0 ? (
                  <ul>
                    {results.actions.map((action, idx) => (
                      <li key={idx}>{action}</li>
                    ))}
                  </ul>
                ) : (
                  <p>No action items found.</p>
                )}
              </div>
              <div className="result-card">
                <h3>Transcript</h3>
                <p style={{ fontStyle: 'italic', opacity: 0.8 }}>"{results.transcript}"</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* RIGHT SIDEBAR */}
      <div className="right-sidebar">
        <h3 style={{ fontSize: '1rem', color: 'var(--text-dark)', marginBottom: '10px' }}>Fireflies Notetaker</h3>
        
        <div className="widget-card">
          <h4>Get unlimited transcripts</h4>
          <p>Upgrade to continuous recording.</p>
        </div>

        <div className="widget-card">
          <h4>Calendar meeting settings</h4>
          <p>Choose auto-join and share settings. ✅</p>
        </div>

        <div className="widget-card">
          <h4>Meeting language</h4>
          <p style={{ color: 'var(--primary)', fontWeight: '500' }}>English (Global)</p>
        </div>

        <h3 style={{ fontSize: '1rem', color: 'var(--text-dark)', margin: '20px 0 10px' }}>Upcoming Meetings</h3>
        <div className="widget-card" style={{ textAlign: 'center', padding: '30px 15px' }}>
          <p style={{ marginBottom: '10px' }}>No meetings in the next week.</p>
          <button className="btn-primary" style={{ width: '100%', justifyContent: 'center' }}>+ Capture</button>
        </div>
      </div>

      {/* FLOATING CHATBOT WIDGET */}
      <div style={{ position: 'fixed', bottom: '30px', right: '30px', zIndex: 1000, cursor: 'pointer', background: 'var(--bg-card)', padding: '10px', borderRadius: '50%', boxShadow: '0 4px 12px rgba(0,0,0,0.15)' }}>
        <img src="/chatbot-logo.png" alt="Chatbot Support" style={{ width: '50px', height: '50px', objectFit: 'contain' }} />
      </div>
    </>
  )
}

export default App
