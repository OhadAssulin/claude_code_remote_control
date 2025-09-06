import * as vscode from 'vscode';
import * as pty from 'node-pty';
import * as path from 'path';

interface Terminal {
    id: string;
    name: string;
    ptyProcess: pty.IPty;
}

class ClaudeTerminalProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'claude-terminal-panel';
    
    private _view?: vscode.WebviewView;
    private terminals: Map<string, Terminal> = new Map();
    private terminalCounter = 1;
    private terminalBuffer: string[] = [];
    private maxBufferLines = 50; // Keep last 50 lines for menu detection
    private menuDetectionTimeout?: NodeJS.Timeout;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'node_modules'),
                vscode.Uri.joinPath(this._extensionUri, 'out')
            ]
        };

        webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.type) {
                    case 'createTerminal':
                        await this.createNewTerminal();
                        break;
                    case 'terminalInput':
                        const terminal = this.terminals.get(message.terminalId);
                        if (terminal) {
                            terminal.ptyProcess.write(message.data);
                        }
                        break;
                    case 'closeTerminal':
                        await this.closeTerminal(message.terminalId);
                        break;
                    case 'resizeTerminal':
                        const resizeTerminal = this.terminals.get(message.terminalId);
                        if (resizeTerminal) {
                            resizeTerminal.ptyProcess.resize(message.cols, message.rows);
                        }
                        break;
                    // No need for restoreTerminals with retainContextWhenHidden
                }
            }
        );

        // Create the first terminal
        this.createNewTerminal();
    }

    private async createNewTerminal() {
        if (!this._view) return;

        const terminalId = `terminal-${this.terminalCounter++}`;
        const terminalName = `Claude ${this.terminalCounter - 1}`;

        // Create a new pty process that runs claude
        const ptyProcess = pty.spawn('claude', [], {
            name: 'xterm-color',
            cols: 80,
            rows: 24,
            cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd(),
            env: process.env as { [key: string]: string }
        });

        const terminal: Terminal = {
            id: terminalId,
            name: terminalName,
            ptyProcess
        };

        this.terminals.set(terminalId, terminal);

        // Handle terminal output
        ptyProcess.onData((data) => {
            if (this._view) {
                this._view.webview.postMessage({
                    type: 'terminalOutput',
                    terminalId: terminalId,
                    data: data
                });
                
                // Parse output for Claude action menus
                this._parseClaudeActions(data);
            }
        });

        // Handle terminal exit
        ptyProcess.onExit(() => {
            this.terminals.delete(terminalId);
            if (this._view) {
                this._view.webview.postMessage({
                    type: 'terminalClosed',
                    terminalId: terminalId
                });
            }
        });

        // Send terminal creation message to webview
        if (this._view) {
            this._view.webview.postMessage({
                type: 'terminalCreated',
                terminalId: terminalId,
                name: terminalName
            });
        }
    }

    private async closeTerminal(terminalId: string) {
        const terminal = this.terminals.get(terminalId);
        if (terminal) {
            terminal.ptyProcess.kill();
            this.terminals.delete(terminalId);
        }
    }

    private _parseClaudeActions(data: string) {
        if (!this._view) return;

        // Add data to buffer for multi-line menu detection
        this._updateTerminalBuffer(data);

        // Clear existing timeout and set new one to detect when output stops
        if (this.menuDetectionTimeout) {
            clearTimeout(this.menuDetectionTimeout);
        }
        
        // Detect menus after output pause (500ms)
        this.menuDetectionTimeout = setTimeout(() => {
            this._detectInteractiveMenu();
        }, 500);
    }

    private _updateTerminalBuffer(data: string) {
        // Split data into lines and add to buffer
        const lines = data.split(/\r?\n/);
        this.terminalBuffer.push(...lines);
        
        // Keep only the last maxBufferLines
        if (this.terminalBuffer.length > this.maxBufferLines) {
            this.terminalBuffer = this.terminalBuffer.slice(-this.maxBufferLines);
        }
    }

    private _detectInteractiveMenu() {
        const fullBuffer = this.terminalBuffer.join('\n');
        
        // Debug: Log what we're analyzing
        console.log('=== Menu Detection Debug ===');
        console.log('Buffer content:', JSON.stringify(fullBuffer.slice(-500))); // Last 500 chars
        
        // Phase 1: Check for box characters + interactive indicators
        const hasBox = this._hasBoxStructure(fullBuffer);
        const hasInteractive = this._hasInteractiveElements(fullBuffer);
        
        console.log('Has box structure:', hasBox);
        console.log('Has interactive elements:', hasInteractive);
        
        if (hasBox && hasInteractive) {
            // Phase 2: Parse menu options dynamically
            const actions = this._parseMenuOptions(fullBuffer);
            
            console.log('Parsed actions:', actions);
            
            if (actions.length > 0) {
                console.log('🎯 Detected Claude interactive menu:', actions);
                // For now, just log to console as requested
                // Later we can uncomment this to show UI:
                // this._view?.webview.postMessage({
                //     type: 'claudeActions',
                //     actions: actions
                // });
            }
        }
    }

    private _hasBoxStructure(text: string): boolean {
        // Remove ANSI escape sequences for cleaner detection
        const cleanText = text.replace(/\x1b\[[0-9;]*[mA-Za-z]/g, '');
        
        console.log('Checking box structure in:', JSON.stringify(cleanText.slice(-200)));
        
        // Look for complete box structures, not just random box characters
        const completeBoxPatterns = [
            /┌[─┬]*┐.*┘/s,        // Complete Unicode box
            /╔[═╦]*╗.*╝/s,        // Complete double-line box
            /\+[-+]*\+.*\+/s      // Complete ASCII box
        ];
        
        for (const pattern of completeBoxPatterns) {
            if (pattern.test(cleanText)) {
                console.log('Found complete box pattern');
                return true;
            }
        }
        
        // Also check for multiple box drawing characters suggesting a structure
        const boxChars = cleanText.match(/[┌┐└┘─│╔╗╚╝═║+|]/g) || [];
        console.log('Found box chars:', boxChars.length, boxChars);
        
        if (boxChars.length >= 4) {
            console.log('Sufficient box characters found');
            return true;
        }
        
        console.log('No box structure detected');
        return false;
    }

    private _hasInteractiveElements(text: string): boolean {
        const cleanText = text.replace(/\x1b\[[0-9;]*[mA-Za-z]/g, '');
        
        console.log('Checking interactive elements in:', JSON.stringify(cleanText.slice(-300)));
        
        // Look for clear numbered menu patterns first - this should be sufficient
        const numberedMenuPattern = /^\s*\d+\.\s+.{3,}/m;
        if (numberedMenuPattern.test(cleanText)) {
            console.log('Found numbered menu pattern');
            
            // Count how many numbered options we have
            const numberedOptions = [...cleanText.matchAll(/^\s*(\d+)\.\s+(.{3,})/gm)];
            console.log('Found numbered options:', numberedOptions.length);
            
            if (numberedOptions.length >= 2) {
                console.log('Multiple numbered options found - this is a menu');
                return true;
            }
        }
        
        // Also look for common Claude prompts
        const claudePrompts = [
            /do\s+you\s+want\s+to/i,          // "Do you want to..."
            /should\s+i\s+proceed/i,           // "Should I proceed"
            /would\s+you\s+like/i,             // "Would you like..."
            /create.*file/i,                   // File creation prompts
            /^\s*\d+\.\s+(yes|no)/mi           // Numbered yes/no options
        ];
        
        for (const pattern of claudePrompts) {
            if (pattern.test(cleanText)) {
                console.log('Found Claude prompt pattern:', pattern);
                return true;
            }
        }
        
        console.log('No interactive elements detected');
        return false;
    }

    private _parseMenuOptions(text: string): Array<{key: string, label: string, description?: string}> {
        const cleanText = text.replace(/\x1b\[[0-9;]*[mA-Za-z]/g, '');
        console.log('Clean text for parsing:', JSON.stringify(cleanText));
        
        const lines = cleanText.split('\n').map(line => line.trim()).filter(line => line.length > 0);
        console.log('Lines to parse:', lines);
        
        const actions: Array<{key: string, label: string, description?: string}> = [];
        
        // Look for numbered menu options - handle Claude's actual format
        for (const line of lines) {
            // Skip lines that are clearly questions (end with ?)
            if (line.trim().endsWith('?')) {
                console.log('Skipping question line:', line);
                continue;
            }
            
            // Look for menu options with Claude's actual format:
            // "│ ❯ 1. Yes" or "│   2. Option text" or just "1. Text"
            const hasMenuNumber = line.match(/[│\s]*[❯\s]*\s*\d+\.\s+/) || line.match(/^\s*\d+\.\s+/);
            const hasLetterOption = line.match(/[│\s]*[❯\s]*\s*\([a-z]\)\s+/i) || line.match(/^\s*\([a-z]\)\s+/i);
            
            if (!hasMenuNumber && !hasLetterOption) {
                console.log('Skipping non-menu line:', line);
                continue;
            }
            
            const option = this._parseClaudeMenuLine(line);
            if (option) {
                actions.push(option);
                console.log('Found menu option:', option);
            }
        }
        
        return actions;
    }
    
    private _parseClaudeMenuLine(line: string): {key: string, label: string, description?: string} | null {
        console.log('Parsing line:', JSON.stringify(line));
        
        // Clean up the line by removing box characters and selection arrows
        const cleanLine = line.replace(/[│╭╮╯╰─]/g, '').replace(/❯/g, '').trim();
        console.log('Clean line:', JSON.stringify(cleanLine));
        
        // Pattern 1: "1. Some description" - extract number as key, use description as label
        let match = cleanLine.match(/^\s*(\d+)\.\s*(.+?)$/);
        if (match) {
            const key = match[1];
            const description = match[2].trim();
            return {
                key: key,
                label: description, // Use the actual description, not "1. text"
                description: description
            };
        }
        
        // Pattern 2: "(x) Some description" - extract letter as key, use description as label
        match = cleanLine.match(/^\s*\(([a-z])\)\s*(.+?)$/i);
        if (match) {
            const key = match[1].toLowerCase();
            const description = match[2].trim();
            return {
                key: key,
                label: description,
                description: description
            };
        }
        
        return null;
    }

    public dispose() {
        // Clean up menu detection timeout
        if (this.menuDetectionTimeout) {
            clearTimeout(this.menuDetectionTimeout);
            this.menuDetectionTimeout = undefined;
        }
        
        // Clean up all terminals
        this.terminals.forEach((terminal) => {
            terminal.ptyProcess.kill();
        });
        this.terminals.clear();
        
        // Clear terminal buffer
        this.terminalBuffer = [];
    }

    private getHtmlForWebview(webview: vscode.Webview) {
        const xtermUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'));
        const xtermCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'));
        const fitAddonUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js'));

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline' 'unsafe-eval'; font-src ${webview.cspSource};">
            <title>Claude Tabbed Terminal</title>
            <link rel="stylesheet" href="${xtermCssUri}">
            <style>
                body {
                    margin: 0;
                    padding: 0;
                    font-family: 'Courier New', monospace;
                    background-color: var(--vscode-panel-background);
                    color: var(--vscode-foreground);
                    overflow: hidden;
                    height: 100vh;
                }
                
                .tab-container {
                    display: flex;
                    flex-direction: row;
                    background-color: var(--vscode-tab-inactiveBackground);
                    border-bottom: 1px solid var(--vscode-panel-border);
                    height: 35px;
                    align-items: stretch;
                    padding: 0 8px;
                    overflow-x: auto;
                    flex-shrink: 0;
                    min-height: 35px;
                }
                
                #tabs {
                    display: flex !important;
                    flex-direction: row !important;
                    align-items: center !important;
                    gap: 2px;
                }
                
                .tab {
                    background-color: var(--vscode-tab-inactiveBackground);
                    border: 1px solid var(--vscode-tab-border);
                    border-bottom: none;
                    padding: 6px 12px;
                    cursor: pointer;
                    display: inline-flex !important;
                    flex-direction: row !important;
                    align-items: center;
                    min-width: 80px;
                    max-width: 150px;
                    position: relative;
                    font-size: 12px;
                    white-space: nowrap;
                    flex-shrink: 0;
                    height: 28px;
                    box-sizing: border-box;
                }
                
                .tab.active {
                    background-color: var(--vscode-tab-activeBackground);
                    border-color: var(--vscode-tab-activeBorder, var(--vscode-focusBorder));
                }
                
                .tab-name {
                    flex-grow: 1;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                
                .tab-close {
                    margin-left: 6px;
                    width: 14px;
                    height: 14px;
                    background: none;
                    border: none;
                    color: var(--vscode-foreground);
                    cursor: pointer;
                    font-size: 10px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    border-radius: 2px;
                }
                
                .tab-close:hover {
                    background-color: var(--vscode-toolbar-hoverBackground);
                }
                
                .new-tab-button {
                    background-color: var(--vscode-button-background);
                    border: 1px solid var(--vscode-button-border, transparent);
                    color: var(--vscode-button-foreground);
                    padding: 4px 8px;
                    cursor: pointer;
                    margin-left: 8px;
                    font-size: 12px;
                    border-radius: 2px;
                }
                
                .new-tab-button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                
                .terminal-container {
                    height: calc(100vh - 35px);
                    display: flex;
                    flex-direction: column;
                    flex-grow: 1;
                }
                
                .terminal-pane {
                    display: none;
                    height: 100%;
                    flex-grow: 1;
                }
                
                .terminal-pane.active {
                    display: block;
                }
                
                .terminal {
                    height: 100%;
                    padding: 0;
                    background: var(--vscode-terminal-background);
                }
                
                .xterm {
                    padding: 8px !important;
                }
                
                .xterm .xterm-viewport {
                    background: var(--vscode-terminal-background) !important;
                }
                
                .xterm .xterm-screen {
                    background: var(--vscode-terminal-background) !important;
                }
            </style>
        </head>
        <body>
            <div class="tab-container">
                <div id="tabs" style="display: flex; flex-direction: row; align-items: center;"></div>
                <button class="new-tab-button" id="newTabButton">+</button>
            </div>
            
            <div class="terminal-container" id="terminalContainer">
            </div>

            <script src="${xtermUri}"></script>
            <script src="${fitAddonUri}"></script>
            <script>
                const vscode = acquireVsCodeApi();
                const terminals = new Map();
                let activeTerminalId = null;
                
                // No need for state persistence with retainContextWhenHidden: true

                // Initialize
                document.addEventListener('DOMContentLoaded', () => {
                    document.getElementById('newTabButton').addEventListener('click', () => {
                        vscode.postMessage({
                            type: 'createTerminal'
                        });
                    });
                });

                // Handle messages from extension
                window.addEventListener('message', event => {
                    const message = event.data;
                    
                    switch (message.type) {
                        case 'terminalCreated':
                            createTerminalTab(message.terminalId, message.name);
                            break;
                        case 'terminalOutput':
                            writeToTerminal(message.terminalId, message.data);
                            break;
                        case 'terminalClosed':
                            closeTerminalTab(message.terminalId);
                            break;
                        // No need for restoreTerminals with retainContextWhenHidden
                    }
                });
                
                // No need for restoration with retainContextWhenHidden

                function createTerminalTab(terminalId, name) {
                    // Create tab
                    const tabsContainer = document.getElementById('tabs');
                    const tab = document.createElement('div');
                    tab.className = 'tab';
                    tab.dataset.terminalId = terminalId;
                    
                    const tabName = document.createElement('span');
                    tabName.className = 'tab-name';
                    tabName.textContent = name;
                    
                    const closeButton = document.createElement('button');
                    closeButton.className = 'tab-close';
                    closeButton.innerHTML = '×';
                    closeButton.addEventListener('click', (e) => {
                        e.stopPropagation();
                        vscode.postMessage({
                            type: 'closeTerminal',
                            terminalId: terminalId
                        });
                    });
                    
                    tab.appendChild(tabName);
                    tab.appendChild(closeButton);
                    tab.addEventListener('click', () => switchTab(terminalId));
                    
                    tabsContainer.appendChild(tab);

                    // Create terminal pane
                    const terminalContainer = document.getElementById('terminalContainer');
                    const terminalPane = document.createElement('div');
                    terminalPane.className = 'terminal-pane';
                    terminalPane.dataset.terminalId = terminalId;
                    
                    const terminalDiv = document.createElement('div');
                    terminalDiv.className = 'terminal';
                    terminalPane.appendChild(terminalDiv);
                    
                    terminalContainer.appendChild(terminalPane);

                    // Get VS Code computed styles
                    const rootStyles = getComputedStyle(document.documentElement);
                    const bodyStyles = getComputedStyle(document.body);
                    
                    // Get VS Code terminal font settings
                    const fontSize = parseInt(rootStyles.getPropertyValue('--vscode-terminal-font-size').trim()) || 
                                   parseInt(rootStyles.getPropertyValue('--vscode-editor-font-size').trim()) || 13;
                    const fontFamily = rootStyles.getPropertyValue('--vscode-terminal-font-family').trim() || 
                                     rootStyles.getPropertyValue('--vscode-editor-font-family').trim() || 
                                     'Menlo, Monaco, "Courier New", monospace';
                    
                    // Create xterm terminal with VS Code terminal settings
                    const terminal = new Terminal({
                        cursorBlink: true,
                        fontFamily: fontFamily,
                        fontSize: fontSize,
                        fontWeight: 'normal',
                        lineHeight: 1.2,
                        letterSpacing: 0,
                        cursorStyle: 'block',
                        cursorWidth: 1,
                        bellStyle: 'none',
                        allowTransparency: false,
                        theme: {
                            background: rootStyles.getPropertyValue('--vscode-terminal-background').trim() || 
                                       rootStyles.getPropertyValue('--vscode-panel-background').trim() || '#1e1e1e',
                            foreground: rootStyles.getPropertyValue('--vscode-terminal-foreground').trim() || 
                                       rootStyles.getPropertyValue('--vscode-foreground').trim() || '#cccccc',
                            cursor: rootStyles.getPropertyValue('--vscode-terminalCursor-foreground').trim() || '#ffffff',
                            cursorAccent: rootStyles.getPropertyValue('--vscode-terminalCursor-background').trim() || '#000000',
                            selection: rootStyles.getPropertyValue('--vscode-terminal-selectionBackground').trim() || '#264f78',
                            black: rootStyles.getPropertyValue('--vscode-terminal-ansiBlack').trim() || '#000000',
                            red: rootStyles.getPropertyValue('--vscode-terminal-ansiRed').trim() || '#cd3131',
                            green: rootStyles.getPropertyValue('--vscode-terminal-ansiGreen').trim() || '#0dbc79',
                            yellow: rootStyles.getPropertyValue('--vscode-terminal-ansiYellow').trim() || '#e5e510',
                            blue: rootStyles.getPropertyValue('--vscode-terminal-ansiBlue').trim() || '#2472c8',
                            magenta: rootStyles.getPropertyValue('--vscode-terminal-ansiMagenta').trim() || '#bc3fbc',
                            cyan: rootStyles.getPropertyValue('--vscode-terminal-ansiCyan').trim() || '#11a8cd',
                            white: rootStyles.getPropertyValue('--vscode-terminal-ansiWhite').trim() || '#e5e5e5',
                            brightBlack: rootStyles.getPropertyValue('--vscode-terminal-ansiBrightBlack').trim() || '#666666',
                            brightRed: rootStyles.getPropertyValue('--vscode-terminal-ansiBrightRed').trim() || '#f14c4c',
                            brightGreen: rootStyles.getPropertyValue('--vscode-terminal-ansiBrightGreen').trim() || '#23d18b',
                            brightYellow: rootStyles.getPropertyValue('--vscode-terminal-ansiBrightYellow').trim() || '#f5f543',
                            brightBlue: rootStyles.getPropertyValue('--vscode-terminal-ansiBrightBlue').trim() || '#3b8eea',
                            brightMagenta: rootStyles.getPropertyValue('--vscode-terminal-ansiBrightMagenta').trim() || '#d670d6',
                            brightCyan: rootStyles.getPropertyValue('--vscode-terminal-ansiBrightCyan').trim() || '#29b8db',
                            brightWhite: rootStyles.getPropertyValue('--vscode-terminal-ansiBrightWhite').trim() || '#e5e5e5'
                        }
                    });
                    
                    // Try multiple ways to instantiate FitAddon
                    let fitAddon;
                    try {
                        if (window.FitAddon && typeof window.FitAddon === 'function') {
                            fitAddon = new window.FitAddon();
                        } else if (window.FitAddon && window.FitAddon.FitAddon) {
                            fitAddon = new window.FitAddon.FitAddon();
                        } else {
                            console.error('FitAddon not found in expected locations');
                            fitAddon = null;
                        }
                    } catch (e) {
                        console.error('Error creating FitAddon:', e);
                        fitAddon = null;
                    }
                    if (fitAddon) {
                        terminal.loadAddon(fitAddon);
                    }
                    
                    terminal.open(terminalDiv);
                    if (fitAddon) {
                        fitAddon.fit();
                    }
                    
                    // Handle terminal input
                    terminal.onData((data) => {
                        vscode.postMessage({
                            type: 'terminalInput',
                            terminalId: terminalId,
                            data: data
                        });
                    });

                    // Handle terminal resize
                    terminal.onResize((size) => {
                        vscode.postMessage({
                            type: 'resizeTerminal',
                            terminalId: terminalId,
                            cols: size.cols,
                            rows: size.rows
                        });
                    });

                    terminals.set(terminalId, {
                        terminal: terminal,
                        fitAddon: fitAddon,
                        name: name
                    });

                    // Switch to new terminal
                    switchTab(terminalId);

                    // Fit terminal after switching
                    setTimeout(() => {
                        if (fitAddon) {
                            fitAddon.fit();
                        }
                    }, 100);
                }

                function writeToTerminal(terminalId, data) {
                    const terminalData = terminals.get(terminalId);
                    if (terminalData) {
                        terminalData.terminal.write(data);
                    }
                }

                function switchTab(terminalId) {
                    // Update tab states
                    document.querySelectorAll('.tab').forEach(tab => {
                        tab.classList.remove('active');
                    });
                    const activeTab = document.querySelector(\`[data-terminal-id="\${terminalId}"]\`);
                    if (activeTab) activeTab.classList.add('active');

                    // Update terminal pane states
                    document.querySelectorAll('.terminal-pane').forEach(pane => {
                        pane.classList.remove('active');
                    });
                    const activePane = document.querySelector(\`.terminal-pane[data-terminal-id="\${terminalId}"]\`);
                    if (activePane) activePane.classList.add('active');

                    activeTerminalId = terminalId;

                    // Fit the active terminal
                    const terminalData = terminals.get(terminalId);
                    if (terminalData && terminalData.fitAddon) {
                        setTimeout(() => {
                            terminalData.fitAddon.fit();
                        }, 100);
                    }
                }

                function closeTerminalTab(terminalId) {
                    // Remove terminal from map
                    const terminalData = terminals.get(terminalId);
                    if (terminalData) {
                        terminalData.terminal.dispose();
                        terminals.delete(terminalId);
                    }

                    // Remove tab and pane
                    const tab = document.querySelector(\`.tab[data-terminal-id="\${terminalId}"]\`);
                    const pane = document.querySelector(\`.terminal-pane[data-terminal-id="\${terminalId}"]\`);
                    
                    if (tab) tab.remove();
                    if (pane) pane.remove();

                    // Switch to another tab if this was active
                    if (activeTerminalId === terminalId) {
                        const remainingTabs = document.querySelectorAll('.tab');
                        if (remainingTabs.length > 0) {
                            const nextTab = remainingTabs[0];
                            switchTab(nextTab.dataset.terminalId);
                        } else {
                            activeTerminalId = null;
                        }
                    }
                }

                // Handle window resize
                window.addEventListener('resize', () => {
                    terminals.forEach((terminalData) => {
                        if (terminalData.fitAddon) {
                            terminalData.fitAddon.fit();
                        }
                    });
                });

                // Canvas-based screenshot function
                async function captureScreenshot(rowCount = 50) {
                    try {
                        console.log('=== Canvas Screenshot (' + rowCount + ' rows) ===');
                        
                        // Get active terminal
                        const activeTerminalData = terminals.get(activeTerminalId);
                        if (!activeTerminalData || !activeTerminalData.terminal) {
                            console.error('No active terminal for screenshot');
                            return;
                        }
                        
                        const terminal = activeTerminalData.terminal;
                        const buffer = terminal.buffer.active;
                        const lineCount = buffer.length;

                        // Collect last N lines
                        let end = lineCount - 1;
                        while (end >= 0 && buffer.getLine(end)?.translateToString(true).trim() === '') {
                            end--;
                        }
                        const start = Math.max(0, end - rowCount + 1);

                        const lines = [];
                        for (let i = start; i <= end; i++) {
                            const line = buffer.getLine(i);
                            if (line) lines.push(line);
                        }

                        if (lines.length === 0) {
                            console.error('No lines to render');
                            return;
                        }

                        console.log('Found ' + lines.length + ' lines to render');

                        // Canvas setup
                        const fontFamily = terminal.options.fontFamily || 'Menlo, Monaco, monospace';
                        const baseFontSize = terminal.options.fontSize || 14;
                        const baseLineHeight = (terminal.options.lineHeight || 1.4) * baseFontSize;
                        const padding = 20;

                        const maxCols = Math.max(...lines.map(l => l.length));
                        const tmpCanvas = document.createElement('canvas');
                        const tmpCtx = tmpCanvas.getContext('2d');
                        tmpCtx.font = baseFontSize + 'px ' + fontFamily;
                        const charWidth = tmpCtx.measureText('M').width;

                        const canvasWidth = maxCols * charWidth + padding * 2;
                        const canvasHeight = lines.length * baseLineHeight + padding * 2;

                        console.log('Canvas setup:', { canvasWidth, canvasHeight, charWidth, maxCols });

                        const canvas = document.createElement('canvas');
                        canvas.width = canvasWidth;
                        canvas.height = canvasHeight;
                        const ctx = canvas.getContext('2d');

                        // Background
                        ctx.fillStyle = terminal.options.theme?.background || '#1e1e1e';
                        ctx.fillRect(0, 0, canvasWidth, canvasHeight);
                        ctx.textBaseline = 'top';

                        // Standard ANSI 16 color palette
                        const ansi16 = [
                            '#000000', '#800000', '#008000', '#808000',
                            '#000080', '#800080', '#008080', '#c0c0c0',
                            '#808080', '#ff0000', '#00ff00', '#ffff00',
                            '#0000ff', '#ff00ff', '#00ffff', '#ffffff'
                        ];

                        let totalCharsDrawn = 0;

                        // Check if CellData is available
                        if (!window.CellData) {
                            console.log('CellData not available, using fallback text rendering');
                            // Fallback to simple text rendering
                            lines.forEach((line, rowIdx) => {
                                const text = line.translateToString(true);
                                const posY = padding + rowIdx * baseLineHeight;
                                
                                ctx.font = baseFontSize + 'px ' + fontFamily;
                                ctx.fillStyle = terminal.options.theme?.foreground || '#ffffff';
                                
                                for (let x = 0; x < text.length; x++) {
                                    const char = text[x] || ' ';
                                    const posX = padding + x * charWidth;
                                    ctx.fillText(char, posX, posY);
                                    totalCharsDrawn++;
                                }
                            });
                            
                            console.log('Fallback rendering complete: ' + totalCharsDrawn + ' characters');
                            
                            // Convert to blob and log (for now, just console log)
                            canvas.toBlob(async (blob) => {
                                if (blob) {
                                    console.log('📸 Screenshot ready: ' + blob.size + ' bytes');
                                    // Here we can later add Telegram sending functionality
                                } else {
                                    console.error('Failed to create blob');
                                }
                            }, 'image/png', 0.95);
                            return;
                        }

                        // Full styled rendering with CellData
                        console.log('Using CellData for styled rendering');
                        const cell = new window.CellData();
                        
                        lines.forEach((line, rowIdx) => {
                            for (let x = 0; x < line.length; x++) {
                                try {
                                    line.getCell(x, cell);
                                    const ch = cell.getChars() || ' ';

                                    // Handle foreground color
                                    let fgStyle = terminal.options.theme?.foreground || '#ffffff';
                                    
                                    if (cell.isFgRGB()) {
                                        const rgb = cell.getFgColor();
                                        fgStyle = 'rgb(' + ((rgb >> 16) & 255) + ', ' + ((rgb >> 8) & 255) + ', ' + (rgb & 255) + ')';
                                    } else if (cell.isFgPalette()) {
                                        const idx = cell.getFgColor();
                                        fgStyle = ansi16[idx] || fgStyle;
                                    } else if (cell.isFgDefault()) {
                                        fgStyle = terminal.options.theme?.foreground || '#ffffff';
                                    }

                                    // Handle background color
                                    let bgStyle = null;
                                    
                                    if (cell.isBgRGB()) {
                                        const rgb = cell.getBgColor();
                                        bgStyle = 'rgb(' + ((rgb >> 16) & 255) + ', ' + ((rgb >> 8) & 255) + ', ' + (rgb & 255) + ')';
                                    } else if (cell.isBgPalette()) {
                                        const idx = cell.getBgColor();
                                        bgStyle = ansi16[idx] || null;
                                    } else if (cell.isBgDefault()) {
                                        bgStyle = null; // transparent, background already painted
                                    }

                                    // Inverse → swap fg/bg
                                    if (cell.isInverse()) {
                                        const tmp = fgStyle;
                                        fgStyle = bgStyle || terminal.options.theme?.background || '#1e1e1e';
                                        bgStyle = tmp;
                                    }

                                    const posX = padding + x * charWidth;
                                    const posY = padding + rowIdx * baseLineHeight;

                                    // Background
                                    if (bgStyle) {
                                        ctx.fillStyle = bgStyle;
                                        ctx.fillRect(posX, posY, charWidth, baseLineHeight);
                                    }

                                    // Font style
                                    let fontParts = [];
                                    if (cell.isItalic()) fontParts.push('italic');
                                    if (cell.isBold()) fontParts.push('bold');
                                    fontParts.push(baseFontSize + 'px');
                                    fontParts.push(fontFamily);
                                    ctx.font = fontParts.join(' ');

                                    // Text
                                    ctx.fillStyle = fgStyle;
                                    ctx.fillText(ch, posX, posY);
                                    totalCharsDrawn++;

                                    // Underline
                                    if (cell.isUnderline()) {
                                        ctx.strokeStyle = fgStyle;
                                        ctx.lineWidth = 1;
                                        const underlineY = posY + baseFontSize;
                                        ctx.beginPath();
                                        ctx.moveTo(posX, underlineY);
                                        ctx.lineTo(posX + charWidth, underlineY);
                                        ctx.stroke();
                                    }
                                } catch (cellError) {
                                    // Fallback for individual cell
                                    const text = line.translateToString(true);
                                    const char = text[x] || ' ';
                                    const posX = padding + x * charWidth;
                                    const posY = padding + rowIdx * baseLineHeight;
                                    
                                    ctx.font = baseFontSize + 'px ' + fontFamily;
                                    ctx.fillStyle = '#ffffff';
                                    ctx.fillText(char, posX, posY);
                                    totalCharsDrawn++;
                                }
                            }
                        });

                        console.log('Styled rendering complete: ' + totalCharsDrawn + ' characters');

                        // Export
                        canvas.toBlob(async (blob) => {
                            if (blob) {
                                console.log('📸 Styled screenshot ready: ' + blob.size + ' bytes');
                                // Here we can later add Telegram sending functionality
                            } else {
                                console.error('Failed to create blob');
                            }
                        }, 'image/png', 0.95);

                    } catch (error) {
                        console.error('Canvas screenshot capture failed:', error);
                    }
                }
            </script>
        </body>
        </html>`;
    }
}

export function activate(context: vscode.ExtensionContext) {
    const provider = new ClaudeTerminalProvider(context.extensionUri);
    
    // Register the webview view provider with retainContextWhenHidden
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            ClaudeTerminalProvider.viewType, 
            provider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true
                }
            }
        )
    );

    const disposable = vscode.commands.registerCommand('claude-remote-control.openTerminal', () => {
        // Set context to make the view visible
        vscode.commands.executeCommand('setContext', 'claudeTerminal.active', true);
        // Show the panel and focus our terminal
        vscode.commands.executeCommand('workbench.action.togglePanel');
        setTimeout(() => {
            vscode.commands.executeCommand('claude-terminal-panel.focus');
        }, 100);
    });

    context.subscriptions.push(disposable);
}

export function deactivate() {
    // Clean up any remaining timeouts would be handled by VS Code
}

// Add dispose method to the provider class if not already present
// This should be added to the ClaudeTerminalProvider class