import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import { GoogleGenAI, Part } from "@google/genai";

// --- TYPESCRIPT DEFINITIONS for Web Speech API ---
interface SpeechRecognitionAlternative { readonly transcript: string; }
interface SpeechRecognitionResult { readonly length: number; readonly isFinal: boolean; item(index: number): SpeechRecognitionAlternative;[index: number]: SpeechRecognitionAlternative; }
interface SpeechRecognitionResultList { readonly length: number; item(index: number): SpeechRecognitionResult;[index: number]: SpeechRecognitionResult; }
interface SpeechRecognitionEvent extends Event { readonly results: SpeechRecognitionResultList; }
interface SpeechRecognitionErrorEvent extends Event { readonly error: string; }
interface SpeechRecognition extends EventTarget {
    continuous: boolean; interimResults: boolean; onstart: (() => void) | null; onend: (() => void) | null;
    onerror: ((event: SpeechRecognitionErrorEvent) => void) | null; onresult: ((event: SpeechRecognitionEvent) => void) | null;
    start: () => void; stop: () => void;
}
interface SpeechRecognitionStatic { new(): SpeechRecognition; }
interface IWindow extends Window { SpeechRecognition?: SpeechRecognitionStatic; webkitSpeechRecognition?: SpeechRecognitionStatic; }

// --- APP-SPECIFIC TYPES AND CONSTANTS ---
type User = { name: string; avatar: string };
type Persona = { id: string; name: string; title: string; avatar: string; color: string; systemInstruction: string; };
type Minute = { personaId: string; round: number; text: string; isError?: boolean };
type Attachment = { name: string; type: 'image' | 'file'; data?: string; mimeType?: string; };
type Deliberation = { id: string; title: string; prompt: string; attachments: Attachment[]; minutes: Minute[]; finalDecision?: string; timestamp: number; mode: DeliberationMode; };
type DeliberationMode = 'full' | 'technologist' | 'debate';
type ChatMessage = { sender: 'user' | 'ai' | 'system'; text: string; image?: string; prompt?: string; actions?: Array<{ text: string; handler: () => void }>; };

const PERSONAS: Persona[] = [
  { id: 'environmentalist', name: 'Dr. Anya Sharma', title: 'Environmentalist', avatar: '🌿', color: '#2ecc71', systemInstruction: 'You are Dr. Anya Sharma, an Environmental Scientist...' },
  { id: 'technologist', name: 'Ben Carter', title: 'Technologist', avatar: '💡', color: '#3498db', systemInstruction: 'You are Ben Carter, a Technology and Engineering expert...' },
  { id: 'ethicist', name: 'Dr. Lena Petrova', title: 'Ethicist', avatar: '⚖️', color: '#9b59b6', systemInstruction: 'You are Dr. Lena Petrova, an Ethicist...' },
  { id: 'economist', name: 'Marcus Cole', title: 'Economist', avatar: '💰', color: '#f1c40f', systemInstruction: 'You are Marcus Cole, an Economist...' },
  { id: 'public-health', name: 'Dr. Kenji Tanaka', title: 'Public Health', avatar: '❤️‍🩹', color: '#e74c3c', systemInstruction: 'You are Dr. Kenji Tanaka, a Public Health Practitioner...' },
];
const TOTAL_ROUNDS = 3;

// --- HELPER FUNCTIONS ---
const fileToBase64 = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = error => reject(error);
});

// --- UI COMPONENTS ---
const AuthDisplay = ({ user, onSignIn, onSignOut }: { user: User | null, onSignIn: () => void, onSignOut: () => void }) => (
    <div className="auth-display">{user ? <div className="user-profile"><img src={user.avatar} alt="User avatar" className="user-avatar" /><span>{user.name}</span><button onClick={onSignOut} className="auth-btn">Sign Out</button></div> : <button onClick={onSignIn} className="auth-btn">Sign in with Google</button>}</div>
);

const Sidebar = ({ history, activeId, onSelect, onNew, isCollapsed }: { history: Deliberation[], activeId: string | null, onSelect: (id: string) => void, onNew: () => void, isCollapsed: boolean }) => (
    <aside className={`sidebar ${isCollapsed ? 'collapsed' : ''}`}><div className="sidebar-header"><button onClick={onNew} className="new-deliberation-btn">New Deliberation</button></div><ul className="history-list">{history.sort((a, b) => b.timestamp - a.timestamp).map(item => <li key={item.id} className={`history-item ${item.id === activeId ? 'active' : ''}`} onClick={() => onSelect(item.id)}>{item.title}</li>)}</ul></aside>
);

const CouncilDisplay = ({ activePersonaId, members }: { activePersonaId: string | null, members: Persona[] }) => (
    <div className="council-display">{members.map(p => <div key={p.id} className={`persona-avatar ${activePersonaId === p.id ? 'active' : ''}`}><div className="avatar-icon" style={{ borderColor: activePersonaId === p.id ? p.color : undefined }}>{p.avatar}</div><div className="persona-name">{p.name}</div><div className="persona-title">{p.title}</div></div>)}</div>
);

const DiscussionLog = ({ minutes }: { minutes: Minute[] }) => (<>{minutes.map((minute, index) => { const persona = PERSONAS.find(p => p.id === minute.personaId); return (<div key={index} className={`minute ${minute.isError ? 'error' : ''}`}><div className="minute-avatar">{persona?.avatar || '⚠️'}</div><div className="minute-content"><div className="minute-header" style={{ color: minute.isError ? 'var(--error-color)' : persona?.color }}>{persona?.name || 'System Error'} (Round {minute.round})</div><p className="minute-text">{minute.text}</p></div></div>); })}</>);
const FinalDecision = ({ decision }: { decision?: string }) => decision && <div className="final-decision-container"><h2>Council's Final Decision</h2><p className="minute-text">{decision}</p></div>;
const AttachmentPreview = ({ attachments, onRemove }: { attachments: Attachment[], onRemove: (name: string) => void }) => attachments.length > 0 && <div className="attachments-preview">{attachments.map(att => <div key={att.name} className="attachment-pill"><span>{att.type === 'image' ? '🖼️' : '📄'} {att.name}</span><button onClick={() => onRemove(att.name)} className="remove-attachment-btn">&times;</button></div>)}</div>;

const InputArea = (props: { userInput: string; setUserInput: (v: string) => void; handleSubmit: (e: React.FormEvent) => void; isLoading: boolean; handleMicClick: () => void; isRecording: boolean; onImageClick: () => void; onFileClick: () => void; mode: DeliberationMode; setMode: (m: DeliberationMode) => void; attachments: Attachment[]; }) => (
    <div className="input-area"><form className="input-form" onSubmit={props.handleSubmit}><button type="button" className={`input-button ${props.isRecording ? 'recording' : ''}`} disabled={props.isLoading} onClick={props.handleMicClick}>🎤</button><button type="button" className="input-button" disabled={props.isLoading} onClick={props.onImageClick}>🖼️</button><button type="button" className="input-button" disabled={props.isLoading} onClick={props.onFileClick}>📎</button><input type="text" className="input-text" placeholder="Enter your proposal..." value={props.userInput} onChange={(e) => props.setUserInput(e.target.value)} disabled={props.isLoading} /><button type="submit" className="input-button submit-button" disabled={props.isLoading || (!props.userInput.trim() && !props.attachments?.length)}>➤</button></form><div className="mode-selector"><button className={`mode-chip ${props.mode === 'full' ? 'active' : ''}`} onClick={() => props.setMode('full')}>Full Council</button><button className={`mode-chip ${props.mode === 'technologist' ? 'active' : ''}`} onClick={() => props.setMode('technologist')}>1-on-1: Technologist</button><button className={`mode-chip ${props.mode === 'debate' ? 'active' : ''}`} onClick={() => props.setMode('debate')}>Debate</button></div></div>
);

const ChatWindow = ({ isOpen, onClose, history, onSend, isLoading, userAvatar }: { isOpen: boolean, onClose: () => void, history: ChatMessage[], onSend: (msg: string) => void, isLoading: boolean, userAvatar?: string }) => {
    const [chatInput, setChatInput] = useState('');
    const messagesEndRef = useRef<HTMLDivElement>(null);
    useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [history]);
    const handleSubmit = (e: React.FormEvent) => { e.preventDefault(); if (!chatInput.trim()) return; onSend(chatInput); setChatInput(''); };
    return <div className={`chat-window ${isOpen ? '' : 'closed'}`}><div className="chat-header"><h3>AI Assistant</h3><button onClick={onClose} className="close-chat-btn">&times;</button></div><div className="chat-messages">{history.map((msg, i) => <div key={i} className={`chat-message ${msg.sender}`}><img src={msg.sender === 'user' ? userAvatar : 'https://api.dicebear.com/8.x/bottts/svg?seed=gemini'} className="chat-message-avatar" /><div className={`chat-message-bubble ${msg.sender}`}><p>{msg.text}</p>{msg.image && <img src={msg.image} alt="Generated wireframe" />}{msg.actions && <div className="action-buttons">{msg.actions.map(action => <button key={action.text} onClick={action.handler} className="auth-btn">{action.text}</button>)}</div></div></div>)}{isLoading && <div className="chat-message ai"><img src="https://api.dicebear.com/8.x/bottts/svg?seed=gemini" className="chat-message-avatar" /><div className="chat-message-bubble ai"><div className="spinner"></div></div></div>}<div ref={messagesEndRef} /></div><form className="chat-input-form" onSubmit={handleSubmit}><input type="text" value={chatInput} onChange={e => setChatInput(e.target.value)} placeholder="Ask a question..." /><button type="submit" disabled={isLoading}>➤</button></form></div>;
};

// --- MAIN APP COMPONENT ---
const App = () => {
    // App State
    const [user, setUser] = useState<User | null>(null);
    const [history, setHistory] = useState<Deliberation[]>([]);
    const [activeDeliberation, setActiveDeliberation] = useState<Deliberation | null>(null);
    const [isSidebarCollapsed, setSidebarCollapsed] = useState(false);
    // Chat State
    const [isChatOpen, setChatOpen] = useState(false);
    const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
    const [isChatLoading, setChatLoading] = useState(false);
    // Input State
    const [userInput, setUserInput] = useState('');
    const [attachments, setAttachments] = useState<Attachment[]>([]);
    const [deliberationMode, setDeliberationMode] = useState<DeliberationMode>('full');
    // Deliberation Flow State
    const [isLoading, setIsLoading] = useState(false);
    const [activePersonaId, setActivePersonaId] = useState<string | null>(null);
    const [currentRound, setCurrentRound] = useState(0);
    // Refs and Speech
    const discussionEndRef = useRef<HTMLDivElement>(null);
    const [isRecording, setIsRecording] = useState(false);
    const recognitionRef = useRef<SpeechRecognition | null>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY as string });

    // --- Effects for Persistence and Setup ---
    useEffect(() => {
        const savedUser = localStorage.getItem('council-user'); if (savedUser) setUser(JSON.parse(savedUser));
        const savedHistory = localStorage.getItem('council-history'); if (savedHistory) setHistory(JSON.parse(savedHistory));
        setChatHistory([{ sender: 'ai', text: 'Hello! How can I help you today?' }]);
    }, []);
    useEffect(() => { localStorage.setItem('council-history', JSON.stringify(history)); }, [history]);
    useEffect(() => { discussionEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [activeDeliberation?.minutes, activeDeliberation?.finalDecision]);
    useEffect(() => {
        const contextText = activeDeliberation ? `I'm now in Council Analyst mode, focused on the deliberation: "${activeDeliberation.title}". Ask me anything about it.` : 'I am in General Assistant mode. Ask me anything, or start a new deliberation.';
        setChatHistory(prev => [...prev, { sender: 'system', text: contextText }]);
    }, [activeDeliberation]);

    // Speech Recognition Setup
    useEffect(() => {
        const SpeechRecognition = (window as IWindow).SpeechRecognition || (window as IWindow).webkitSpeechRecognition; if (!SpeechRecognition) return;
        const recognition: SpeechRecognition = new SpeechRecognition();
        recognition.continuous = true; recognition.interimResults = true;
        recognition.onstart = () => setIsRecording(true); recognition.onend = () => setIsRecording(false);
        recognition.onerror = (e) => console.error('Speech recognition error:', e.error);
        recognition.onresult = (e) => setUserInput(Array.from(e.results).map(r => r[0].transcript).join(''));
        recognitionRef.current = recognition;
    }, []);
    
    // --- Handlers ---
    const handleSignIn = () => { const mockUser = { name: 'Alex', avatar: `https://api.dicebear.com/8.x/initials/svg?seed=Alex` }; setUser(mockUser); localStorage.setItem('council-user', JSON.stringify(mockUser)); };
    const handleSignOut = () => { setUser(null); localStorage.removeItem('council-user'); };
    const handleNewDeliberation = () => setActiveDeliberation(null);
    const handleSelectDeliberation = (id: string) => setActiveDeliberation(history.find(d => d.id === id) || null);
    const handleMicClick = () => isRecording ? recognitionRef.current?.stop() : recognitionRef.current?.start();
    const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>, type: 'image' | 'file') => {
        const file = event.target.files?.[0]; if (!file) return;
        const newAttachment: Attachment = { name: file.name, type };
        if (type === 'image') { newAttachment.data = await fileToBase64(file); newAttachment.mimeType = file.type; }
        setAttachments(prev => [...prev, newAttachment]); event.target.value = '';
    };

    // --- Chatbot Logic ---
    const handleSendMessage = async (message: string) => {
        setChatHistory(prev => [...prev, { sender: 'user', text: message }]);
        setChatLoading(true);
        let systemInstruction = "You are a helpful AI assistant. Use Google Search if you need up-to-date information.";
        let prompt = message;
        if (activeDeliberation) {
            systemInstruction = "You are an AI assistant helping a user understand a council deliberation. Use ONLY the provided context to answer the user's question about the deliberation. Do not use external knowledge or search.";
            const context = `CONTEXT:\n- Deliberation Title: ${activeDeliberation.title}\n- Initial Prompt: ${activeDeliberation.prompt}\n- Minutes:\n${activeDeliberation.minutes.map(m => `  - ${PERSONAS.find(p => p.id === m.personaId)?.name}: "${m.text}"`).join('\n')}\n- Final Decision: ${activeDeliberation.finalDecision}\n\nQUESTION: ${message}`;
            prompt = context;
        }
        try {
            const response = await ai.models.generateContent({ model: 'gemini-3-pro-preview', contents: prompt, config: { systemInstruction, tools: activeDeliberation ? [] : [{ googleSearch: {} }] } });
            const responseText = response.text || "Sorry, I couldn't generate a response.";
            const confusedKeywords = ["sorry", "don't understand", "not sure how"];
            if (!activeDeliberation && confusedKeywords.some(kw => responseText.toLowerCase().includes(kw))) {
                setChatHistory(prev => [...prev, {
                    sender: 'ai', text: responseText, prompt: message,
                    actions: [
                        { text: 'Generate Wireframe', handler: () => generateCreative('image', message) },
                        { text: 'Generate Video Concept', handler: () => generateCreative('video', message) }
                    ]
                }]);
            } else {
                setChatHistory(prev => [...prev, { sender: 'ai', text: responseText }]);
            }
        } catch (error) { setChatHistory(prev => [...prev, { sender: 'ai', text: `An error occurred: ${error}` }]); } finally { setChatLoading(false); }
    };

    const generateCreative = async (type: 'image' | 'video', prompt: string) => {
        setChatLoading(true);
        const newPrompt = type === 'image' ? `Generate a black and white, low-fidelity, sketchy wireframe for a user interface based on this concept: ${prompt}` : `Generate a short, punchy, one-paragraph video concept or script idea for an ad based on this concept: ${prompt}`;
        try {
            if (type === 'image') {
                const response = await ai.models.generateContent({ model: 'gemini-2.5-flash-image', contents: { parts: [{ text: newPrompt }] } });
                const imagePart = response.candidates?.[0].content.parts.find(p => p.inlineData);
                if (imagePart?.inlineData) {
                    const imageUrl = `data:image/png;base64,${imagePart.inlineData.data}`;
                    setChatHistory(prev => [...prev, { sender: 'ai', text: 'Here is the wireframe I came up with:', image: imageUrl }]);
                } else { throw new Error('No image was generated.'); }
            } else { // video concept
                const response = await ai.models.generateContent({ model: 'gemini-3-pro-preview', contents: newPrompt });
                setChatHistory(prev => [...prev, { sender: 'ai', text: `Here's a video concept:\n\n${response.text}` }]);
            }
        } catch (error) { setChatHistory(prev => [...prev, { sender: 'ai', text: `Sorry, I couldn't generate the creative content. ${error}` }]); } finally { setChatLoading(false); }
    };
    
    // --- Core Deliberation Logic ---
    const runDeliberation = async (prompt: string, attachedFiles: Attachment[], mode: DeliberationMode) => {
        setIsLoading(true); setUserInput(''); setAttachments([]);
        const newDeliberation: Deliberation = { id: `delib_${Date.now()}`, title: prompt.substring(0, 25) + '...', prompt, attachments: attachedFiles, minutes: [], timestamp: Date.now(), mode };
        setActiveDeliberation(newDeliberation);
        const deliberationMembers = { 'full': PERSONAS, 'technologist': PERSONAS.filter(p => p.id === 'technologist'), 'debate': PERSONAS.filter(p => ['ethicist', 'economist'].includes(p.id)) }[mode];
        const userPromptParts: Part[] = [{ text: `User proposal: "${prompt}"` }];
        const imageAttachment = attachedFiles.find(a => a.type === 'image');
        if (imageAttachment?.data && imageAttachment.mimeType) userPromptParts.push({ inlineData: { data: imageAttachment.data, mimeType: imageAttachment.mimeType } });
        if (attachedFiles.filter(a => a.type !== 'image').length > 0) userPromptParts.push({ text: `Consider attached documents: ${attachedFiles.filter(a => a.type !== 'image').map(a => a.name).join(', ')}.` });
        let conversationHistory: Part[] = [...userPromptParts];
        try {
            const rounds = mode === 'technologist' ? 1 : TOTAL_ROUNDS;
            for (let round = 1; round <= rounds; round++) {
                setCurrentRound(round);
                for (const persona of deliberationMembers) {
                    setActivePersonaId(persona.id);
                    const personaPrompt: Part[] = [...conversationHistory, { text: `\nYour turn, ${persona.name}. Provide your minute for Round ${round}.` }];
                    const response = await ai.models.generateContent({ model: 'gemini-3-pro-preview', contents: { parts: personaPrompt }, config: { systemInstruction: persona.systemInstruction, tools: [{ googleSearch: {} }], thinkingConfig: { thinkingBudget: 32768 } } });
                    const newMinute: Minute = { personaId: persona.id, round, text: response.text || "No response." };
                    newDeliberation.minutes.push(newMinute); setActiveDeliberation({ ...newDeliberation });
                    conversationHistory.push({ text: `Minute from ${persona.name} in Round ${round}:\n${response.text}` });
                }
            }
            const finalDecisionPrompt = [...conversationHistory, { text: `\nSynthesize all minutes into a unified final decision.` }];
            const finalResponse = await ai.models.generateContent({ model: 'gemini-3-pro-preview', contents: { parts: finalDecisionPrompt }, config: { systemInstruction: "You are the impartial chair.", thinkingConfig: { thinkingBudget: 32768 } } });
            newDeliberation.finalDecision = finalResponse.text; setActiveDeliberation({ ...newDeliberation });
            setHistory(prev => [...prev.filter(d => d.id !== newDeliberation.id), newDeliberation]);
        } catch (error) {
            const errorMinute: Minute = { personaId: 'system', round: currentRound, text: `${error}`, isError: true };
            newDeliberation.minutes.push(errorMinute); setActiveDeliberation({ ...newDeliberation });
            setHistory(prev => [...prev.filter(d => d.id !== newDeliberation.id), newDeliberation]);
        } finally { setIsLoading(false); setActivePersonaId(null); setCurrentRound(0); }
    };
    const handleSubmit = (e: React.FormEvent) => { e.preventDefault(); if ((!userInput.trim() && attachments.length === 0) || isLoading) return; if (isRecording) recognitionRef.current?.stop(); runDeliberation(userInput, attachments, deliberationMode); };
    const currentMembers = activeDeliberation ? { 'full': PERSONAS, 'technologist': PERSONAS.filter(p => p.id === 'technologist'), 'debate': PERSONAS.filter(p => ['ethicist', 'economist'].includes(p.id)) }[activeDeliberation.mode] : PERSONAS;
    
    return (
        <div className="app-shell">
            <input type="file" ref={imageInputRef} style={{ display: 'none' }} accept="image/jpeg,image/png" onChange={(e) => handleFileChange(e, 'image')} />
            <input type="file" ref={fileInputRef} style={{ display: 'none' }} accept=".pdf,.txt,.md" onChange={(e) => handleFileChange(e, 'file')} />
            {user && <Sidebar history={history} activeId={activeDeliberation?.id || null} onSelect={handleSelectDeliberation} onNew={handleNewDeliberation} isCollapsed={isSidebarCollapsed} />}
            <div className="main-container">
                <header className="app-header"><div className="header-left">{user && <button className="sidebar-toggle" onClick={() => setSidebarCollapsed(!isSidebarCollapsed)}>☰</button>}<h1>Council</h1></div><AuthDisplay user={user} onSignIn={handleSignIn} onSignOut={handleSignOut} /></header>
                <div className="app-content">
                    {!user ? <div className="placeholder-text"><h2>Welcome to the Council</h2><p>Please sign in to begin a new deliberation.</p></div> :
                     !activeDeliberation ? <div className="placeholder-text"><h2>New Deliberation</h2><p>Select a mode, enter a proposal, and the council will convene.</p></div> :
                     (<div className="deliberation-view">
                        <div className="council-header"><h2>{activeDeliberation.prompt.substring(0, 40)}...</h2></div>
                        <CouncilDisplay activePersonaId={activePersonaId} members={currentMembers} />
                        <main className="main-content" aria-live="polite">
                            <DiscussionLog minutes={activeDeliberation.minutes} />
                            {isLoading && <div className="loader" role="status"><div className="spinner"></div><span>Deliberating... Round {currentRound}</span></div>}
                            <FinalDecision decision={activeDeliberation.finalDecision} />
                            <div ref={discussionEndRef} />
                        </main>
                    </div>)}
                    {user && !isLoading && !activeDeliberation?.finalDecision && <InputArea userInput={userInput} setUserInput={setUserInput} handleSubmit={handleSubmit} isLoading={isLoading} handleMicClick={handleMicClick} isRecording={isRecording} onImageClick={() => imageInputRef.current?.click()} onFileClick={() => fileInputRef.current?.click()} mode={deliberationMode} setMode={setDeliberationMode} attachments={attachments} />}
                    {!isLoading && attachments.length > 0 && <AttachmentPreview attachments={attachments} onRemove={(name) => setAttachments(atts => atts.filter(a => a.name !== name))} />}
                </div>
            </div>
            {user && <><button className="chat-widget-button" onClick={() => setChatOpen(true)}>💬</button><ChatWindow isOpen={isChatOpen} onClose={() => setChatOpen(false)} history={chatHistory} onSend={handleSendMessage} isLoading={isChatLoading} userAvatar={user.avatar} /></>}
        </div>
    );
};
const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(<React.StrictMode><App /></React.StrictMode>);