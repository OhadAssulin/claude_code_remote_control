import * as vscode from 'vscode';
import * as pty from 'node-pty';
import * as path from 'path';

interface Terminal {
    id: string;
    name: string;
    ptyProcess: pty.IPty;
}

export function activate(context: vscode.ExtensionContext) {
    let currentPanel: vscode.WebviewPanel | undefined = undefined;
    const terminals: Map<string, Terminal> = new Map();
    let terminalCounter = 1;

    const disposable = vscode.commands.registerCommand('claude-tabbed-terminal.openTerminal', () => {
        if (currentPanel) {
            currentPanel.reveal(vscode.ViewColumn.One);
        } else {
            currentPanel = vscode.window.createWebviewPanel(
                'claudeTerminal',
                'Claude Tabbed Terminal',
                vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true,
                    localResourceRoots: [
                        vscode.Uri.joinPath(context.extensionUri, 'node_modules'),
                        vscode.Uri.joinPath(context.extensionUri, 'out')
                    ]
                }
            );

            currentPanel.webview.html = getWebviewContent(currentPanel.webview, context.extensionUri);

            currentPanel.onDidDispose(() => {
                currentPanel = undefined;
                // Clean up all terminals
                terminals.forEach(terminal => {
                    terminal.ptyProcess.kill();
                });
                terminals.clear();
            }, null, context.subscriptions);

            // Handle messages from the webview
            currentPanel.webview.onDidReceiveMessage(
                async (message) => {
                    switch (message.type) {
                        case 'createTerminal':
                            await createNewTerminal();
                            break;
                        case 'terminalInput':
                            const terminal = terminals.get(message.terminalId);
                            if (terminal) {
                                terminal.ptyProcess.write(message.data);
                            }
                            break;
                        case 'closeTerminal':
                            await closeTerminal(message.terminalId);
                            break;
                        case 'resizeTerminal':
                            const resizeTerminal = terminals.get(message.terminalId);
                            if (resizeTerminal) {
                                resizeTerminal.ptyProcess.resize(message.cols, message.rows);
                            }
                            break;
                    }
                },
                undefined,
                context.subscriptions
            );

            // Create the first terminal
            createNewTerminal();
        }
    });

    async function createNewTerminal() {
        const terminalId = `terminal-${terminalCounter++}`;
        const terminalName = `Claude ${terminalCounter - 1}`;

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

        terminals.set(terminalId, terminal);

        // Handle terminal output
        ptyProcess.onData((data) => {
            if (currentPanel) {
                currentPanel.webview.postMessage({
                    type: 'terminalOutput',
                    terminalId: terminalId,
                    data: data
                });
            }
        });

        // Handle terminal exit
        ptyProcess.onExit(() => {
            terminals.delete(terminalId);
            if (currentPanel) {
                currentPanel.webview.postMessage({
                    type: 'terminalClosed',
                    terminalId: terminalId
                });
            }
        });

        // Send terminal creation message to webview
        if (currentPanel) {
            currentPanel.webview.postMessage({
                type: 'terminalCreated',
                terminalId: terminalId,
                name: terminalName
            });
        }
    }

    async function closeTerminal(terminalId: string) {
        const terminal = terminals.get(terminalId);
        if (terminal) {
            terminal.ptyProcess.kill();
            terminals.delete(terminalId);
        }
    }

    context.subscriptions.push(disposable);
}

function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const xtermUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'));
    const xtermCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'));
    const fitAddonUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'node_modules', '@xterm', 'addon-fit', 'lib', 'xterm-addon-fit.js'));

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Claude Tabbed Terminal</title>
        <link rel="stylesheet" href="${xtermCssUri}">
        <style>
            body {
                margin: 0;
                padding: 0;
                font-family: 'Courier New', monospace;
                background-color: #1e1e1e;
                color: #d4d4d4;
                overflow: hidden;
            }
            
            .tab-container {
                display: flex;
                background-color: #2d2d30;
                border-bottom: 1px solid #3e3e42;
                height: 40px;
                align-items: center;
                padding: 0 10px;
            }
            
            .tab {
                background-color: #3c3c3c;
                border: 1px solid #3e3e42;
                border-bottom: none;
                padding: 8px 16px;
                margin-right: 2px;
                cursor: pointer;
                display: flex;
                align-items: center;
                min-width: 100px;
                position: relative;
            }
            
            .tab.active {
                background-color: #1e1e1e;
                border-color: #007acc;
            }
            
            .tab-name {
                flex-grow: 1;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            
            .tab-close {
                margin-left: 8px;
                width: 16px;
                height: 16px;
                background: none;
                border: none;
                color: #cccccc;
                cursor: pointer;
                font-size: 12px;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            
            .tab-close:hover {
                background-color: #e81123;
                color: white;
            }
            
            .new-tab-button {
                background-color: #0e639c;
                border: 1px solid #007acc;
                color: white;
                padding: 8px 12px;
                cursor: pointer;
                margin-left: 10px;
            }
            
            .new-tab-button:hover {
                background-color: #1177bb;
            }
            
            .terminal-container {
                height: calc(100vh - 40px);
                display: flex;
                flex-direction: column;
            }
            
            .terminal-pane {
                display: none;
                height: 100%;
            }
            
            .terminal-pane.active {
                display: block;
            }
            
            .terminal {
                height: 100%;
                padding: 10px;
            }
        </style>
    </head>
    <body>
        <div class="tab-container">
            <div id="tabs"></div>
            <button class="new-tab-button" id="newTabButton">+ New Terminal</button>
        </div>
        
        <div class="terminal-container" id="terminalContainer">
        </div>

        <script src="${xtermUri}"></script>
        <script src="${fitAddonUri}"></script>
        <script>
            const vscode = acquireVsCodeApi();
            const terminals = new Map();
            let activeTerminalId = null;

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
                }
            });

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

                // Create xterm terminal
                const terminal = new Terminal({
                    cursorBlink: true,
                    fontFamily: '"Courier New", monospace',
                    fontSize: 14,
                    theme: {
                        background: '#1e1e1e',
                        foreground: '#d4d4d4'
                    }
                });
                
                const fitAddon = new FitAddon.FitAddon();
                terminal.loadAddon(fitAddon);
                
                terminal.open(terminalDiv);
                fitAddon.fit();
                
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
                    fitAddon: fitAddon
                });

                // Switch to new terminal
                switchTab(terminalId);

                // Fit terminal after switching
                setTimeout(() => {
                    fitAddon.fit();
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
                document.querySelector(\`[data-terminal-id="\${terminalId}"]\`).classList.add('active');

                // Update terminal pane states
                document.querySelectorAll('.terminal-pane').forEach(pane => {
                    pane.classList.remove('active');
                });
                document.querySelector(\`.terminal-pane[data-terminal-id="\${terminalId}"]\`).classList.add('active');

                activeTerminalId = terminalId;

                // Fit the active terminal
                const terminalData = terminals.get(terminalId);
                if (terminalData) {
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
                    terminalData.fitAddon.fit();
                });
            });
        </script>
    </body>
    </html>`;
}

export function deactivate() {}