// JSX fixture of javascript-signals.yaml: the rules that read JSX. Never run.

// ruleid: jgates.js.uses-file-upload, jgates.js.uses-browser-dom
const Uploader = <input type="file" name="avatar" accept="image/*" />;

// ok: jgates.js.uses-file-upload
// ruleid: jgates.js.uses-browser-dom
const Plain = <input type="text" name="avatar" />;

// ruleid: jgates.js.uses-browser-dom
const Page = <div className="page">hello</div>;
