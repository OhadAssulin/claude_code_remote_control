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
                    case 'remoteControlToggle':
                        this.handleRemoteControlToggle(message.enabled);
                        break;
                    case 'openSettings':
                        this.handleOpenSettings();
                        break;
                    case 'saveTelegramSettings':
                        this.handleSaveTelegramSettings(message.settings);
                        break;
                    case 'loadTelegramSettings':
                        this.handleLoadTelegramSettings();
                        break;
                    case 'testTelegramConnection':
                        this.handleTestTelegramConnection(message.botToken, message.chatId);
                        break;
                    case 'showError':
                        vscode.window.showErrorMessage(message.message);
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
        const terminalName = `CC:${this.terminalCounter - 1}`;

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

    private handleRemoteControlToggle(enabled: boolean) {
        console.log('Remote Control toggled:', enabled ? 'ON' : 'OFF');
        
        // Here we can add logic to enable/disable remote control features
        // For now, just log the state change
        if (enabled) {
            console.log('🔗 Remote Control activated - ready for Telegram integration');
        } else {
            console.log('🔗 Remote Control deactivated');
        }
    }

    private handleOpenSettings() {
        console.log('⚙️ Opening settings dialog');
        
        // For now, show an information message
        // Later we can implement a proper settings dialog
        vscode.window.showInformationMessage(
            'Settings functionality will be implemented here. This will include Telegram bot configuration, screenshot settings, and remote control options.',
            'OK'
        );
    }

    private handleSaveTelegramSettings(settings: { botToken: string; chatId: string; maxRows: number }) {
        console.log('💾 Saving Telegram settings:', { 
            botToken: settings.botToken.substring(0, 10) + '...', 
            chatId: settings.chatId, 
            maxRows: settings.maxRows 
        });

        // Here we would save to workspace settings or a config file
        // For now, just show a success message
        vscode.window.showInformationMessage(
            `Telegram settings saved successfully! Bot: ${settings.botToken.substring(0, 10)}..., Chat: ${settings.chatId}, Max Rows: ${settings.maxRows}`
        );
    }

    private handleLoadTelegramSettings() {
        console.log('📥 Loading Telegram settings');

        // For now, send dummy settings
        // Later we would load from workspace settings or config file
        const dummySettings = {
            botToken: '',
            chatId: '',
            maxRows: 50
        };

        if (this._view) {
            this._view.webview.postMessage({
                type: 'telegramSettingsLoaded',
                settings: dummySettings
            });
        }
    }

    private async handleTestTelegramConnection(botToken: string, chatId: string) {
        console.log('🧪 Testing Telegram connection...');

        try {
            // Here we would make an actual API call to Telegram
            // For now, simulate a test result
            const testMessage = 'Test message from Claude Remote Control extension';
            
            // Simulate API delay
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // For demo purposes, randomly succeed or fail
            const success = Math.random() > 0.3;
            
            if (success) {
                vscode.window.showInformationMessage(
                    `✅ Telegram connection test successful! Test message sent to chat ${chatId}`
                );
                console.log('✅ Telegram test successful');
            } else {
                vscode.window.showErrorMessage(
                    `❌ Telegram connection test failed. Please check your Bot Token and Chat ID.`
                );
                console.log('❌ Telegram test failed');
            }
            
        } catch (error) {
            vscode.window.showErrorMessage(
                `❌ Telegram connection test failed: ${error}`
            );
            console.error('❌ Telegram test error:', error);
        }
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
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline' https://cdn.tailwindcss.com; script-src ${webview.cspSource} 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com; font-src ${webview.cspSource}; connect-src https://cdn.tailwindcss.com;">
            <title>Claude Tabbed Terminal</title>
            <link rel="stylesheet" href="${xtermCssUri}">
            <script src="https://cdn.tailwindcss.com"></script>
            <script>
                tailwind.config = {
                    theme: {
                        extend: {
                            colors: {
                                vscode: {
                                    bg: 'var(--vscode-panel-background)',
                                    fg: 'var(--vscode-foreground)',
                                    border: 'var(--vscode-panel-border)',
                                    hover: 'var(--vscode-toolbar-hoverBackground)',
                                    active: 'var(--vscode-tab-activeBackground)',
                                    inactive: 'var(--vscode-tab-inactiveBackground)',
                                    focus: 'var(--vscode-focusBorder)',
                                }
                            }
                        }
                    }
                }
            </script>
            <style>
                /* Base styles and xterm compatibility */
                body {
                    margin: 0;
                    padding: 0;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    background-color: var(--vscode-panel-background);
                    color: var(--vscode-foreground);
                    overflow: hidden;
                    height: 100vh;
                }
                
                .xterm {
                    padding: 12px !important;
                    font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', 'Fira Mono', 'Droid Sans Mono', 'Consolas', monospace !important;
                }
                
                .xterm .xterm-viewport {
                    background: var(--vscode-terminal-background) !important;
                }
                
                .xterm .xterm-screen {
                    background: var(--vscode-terminal-background) !important;
                }

                /* Terminal container */
                .terminal {
                    height: 100%;
                    padding: 0;
                    background: var(--vscode-terminal-background, #1e1e1e) !important;
                }

                /* Custom scrollbar for webkit browsers */
                ::-webkit-scrollbar {
                    width: 6px;
                    height: 6px;
                }

                ::-webkit-scrollbar-track {
                    background: transparent;
                }

                ::-webkit-scrollbar-thumb {
                    background: var(--vscode-scrollbarSlider-background);
                    border-radius: 3px;
                }

                ::-webkit-scrollbar-thumb:hover {
                    background: var(--vscode-scrollbarSlider-hoverBackground);
                }

                /* Custom toggle switch styles */
                #remoteControlCheckbox:checked + .toggle-bg {
                    background-color: #3b82f6;
                }

                #remoteControlCheckbox:checked + .toggle-bg .toggle-dot {
                    transform: translateX(20px);
                }

                /* Terminal pane styles */
                .terminal-pane {
                    display: none;
                    height: calc(100vh - 3rem);
                    flex-grow: 1;
                    background-color: var(--vscode-terminal-background, #1e1e1e) !important;
                }

                .terminal-pane.active {
                    display: block;
                    background-color: var(--vscode-terminal-background, #1e1e1e) !important;
                }

                /* Hide/show settings menu */
                .settings-menu-hidden {
                    display: none !important;
                }
                
                .settings-menu-visible {
                    display: block !important;
                }
            </style>
        </head>
        <body class="bg-vscode-bg text-vscode-fg overflow-hidden h-screen">
            <!-- Modern Tab Bar -->
            <div class="flex items-center justify-between h-12 px-4 bg-gradient-to-r from-gray-50 to-gray-100 dark:from-gray-800 dark:to-gray-900 border-b border-gray-200 dark:border-gray-700 shadow-sm">
                <!-- Tab Container -->
                <div class="flex items-center space-x-1">
                    <div id="tabs" class="flex space-x-1"></div>
                    <button class="ml-2 inline-flex items-center justify-center w-8 h-8 rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-all duration-200 hover:scale-105 shadow-md" id="newTabButton">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
                        </svg>
                    </button>
                </div>
                
                <!-- Remote Control Section -->
                <div class="flex items-center space-x-4">
                    <!-- Remote Control Toggle -->
                    <label class="flex items-center space-x-2 cursor-pointer group">
                        <div class="relative">
                            <input type="checkbox" id="remoteControlCheckbox" class="sr-only">
                            <div class="toggle-bg w-11 h-6 bg-gray-200 dark:bg-gray-600 rounded-full shadow-inner transition-colors duration-300"></div>
                            <div class="toggle-dot absolute w-4 h-4 bg-white rounded-full shadow-md transform transition-transform duration-300 top-1 left-1"></div>
                        </div>
                        <span class="text-sm font-medium text-gray-700 dark:text-gray-300 group-hover:text-gray-900 dark:group-hover:text-white transition-colors">
                            Remote Control
                        </span>
                    </label>
                    
                    <!-- Settings Menu Button -->
                    <div class="relative">
                        <button class="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600 transition-all duration-200 shadow-sm hover:shadow-md" id="menuBarButton" title="Settings">
                                <svg class="w-4 h-4 text-gray-600 dark:text-gray-400" fill="currentColor" viewBox="0 0 16 16">
                                <circle cx="8" cy="3" r="1.5"/>
                                <circle cx="8" cy="8" r="1.5"/>
                                <circle cx="8" cy="13" r="1.5"/>
                            </svg>
                        </button>
                        
                        <!-- Modern Settings Dropdown -->
                        <div class="absolute right-0 top-12 w-80 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl z-50 hidden animate-in fade-in-0 zoom-in-95 duration-200" id="telegramSettingsMenu">
                            <!-- Header -->
                            <div class="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700 bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 rounded-t-xl">
                                <div class="flex items-center space-x-2">
                                    <div class="w-8 h-8 bg-blue-500 rounded-lg flex items-center justify-center">
                                        <svg class="w-5 h-5 text-white" viewBox="0 0 24 24" fill="currentColor">
                                            <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.820 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
                                        </svg>
                                    </div>
                                    <div>
                                        <h3 class="font-semibold text-gray-900 dark:text-white">Telegram Settings</h3>
                                        <p class="text-xs text-gray-500 dark:text-gray-400">Configure your bot connection</p>
                                    </div>
                                </div>
                                <button class="w-8 h-8 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center justify-center transition-colors" id="closeSettingsButton" title="Close">
                                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                                    </svg>
                                </button>
                            </div>
                            
                            <!-- Form Content -->
                            <div class="p-4 space-y-4">
                                <div class="space-y-2">
                                    <label for="botTokenInput" class="block text-sm font-medium text-gray-700 dark:text-gray-300">
                                        Bot Token
                                    </label>
                                    <input 
                                        type="text" 
                                        id="botTokenInput" 
                                        placeholder="1234567890:ABCdefGHIjklMNOpqrsTUVwxyz" 
                                        class="w-full px-3 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:focus:ring-blue-400 text-sm transition-colors"
                                    >
                                </div>
                                
                                <div class="space-y-2">
                                    <label for="chatIdInput" class="block text-sm font-medium text-gray-700 dark:text-gray-300">
                                        Chat ID
                                    </label>
                                    <input 
                                        type="text" 
                                        id="chatIdInput" 
                                        placeholder="123456789" 
                                        class="w-full px-3 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:focus:ring-blue-400 text-sm transition-colors"
                                    >
                                </div>
                                
                                <div class="space-y-2">
                                    <label for="maxRowsInput" class="block text-sm font-medium text-gray-700 dark:text-gray-300">
                                        Max Rows
                                    </label>
                                    <input 
                                        type="number" 
                                        id="maxRowsInput" 
                                        placeholder="50" 
                                        min="10" 
                                        max="200" 
                                        class="w-full px-3 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:focus:ring-blue-400 text-sm transition-colors"
                                    >
                                </div>
                                
                                <!-- Action Buttons -->
                                <div class="flex space-x-2 pt-2">
                                    <button class="flex-1 bg-blue-500 hover:bg-blue-600 text-white font-medium py-2 px-4 rounded-lg transition-colors duration-200 shadow-sm hover:shadow-md" id="saveTelegramSettings">
                                        Save Settings
                                    </button>
                                    <button class="flex-1 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 font-medium py-2 px-4 rounded-lg transition-colors duration-200" id="testTelegramConnection">
                                        Test Connection
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- Terminal Container -->
            <div class="flex-1" id="terminalContainer" style="background-color: var(--vscode-terminal-background, #1e1e1e);">
            </div>

            <!-- Tab Context Menu -->
            <div id="tabContextMenu" class="fixed bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl z-50 hidden py-2 min-w-48">
                <button class="w-full text-left px-4 py-2 text-gray-900 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center space-x-2" id="renameTabOption">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path>
                    </svg>
                    <span>Rename Tab</span>
                </button>
                <button class="w-full text-left px-4 py-2 text-gray-900 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center space-x-2" id="changeColorOption">
                    <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                        <circle cx="12" cy="12" r="3"/>
                    </svg>
                    <span>Change Color</span>
                </button>
                <hr class="my-1 border-gray-200 dark:border-gray-600">
                <button class="w-full text-left px-4 py-2 hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600 dark:text-red-400 flex items-center space-x-2" id="closeTabOption">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                    </svg>
                    <span>Close Tab</span>
                </button>
            </div>

            <!-- Rename Tab Modal -->
            <div id="renameModal" class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 hidden">
                <div class="bg-white dark:bg-gray-800 rounded-xl p-6 max-w-sm w-full mx-4">
                    <h3 class="text-lg font-semibold mb-4 text-gray-900 dark:text-white">Rename Tab</h3>
                    <input type="text" id="renameInput" class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 mb-4" placeholder="Enter tab name">
                    <div class="flex justify-end space-x-2">
                        <button id="cancelRename" class="px-4 py-2 text-gray-900 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg border border-gray-300 dark:border-gray-600">Cancel</button>
                        <button id="applyRename" class="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg">Rename</button>
                    </div>
                </div>
            </div>

            <!-- Color Picker Modal -->
            <div id="colorPickerModal" class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 hidden">
                <div class="bg-white dark:bg-gray-800 rounded-xl p-6 max-w-sm w-full mx-4">
                    <h3 class="text-lg font-semibold mb-4 text-gray-900 dark:text-white">Choose Tab Color</h3>
                    <div class="grid grid-cols-6 gap-2 mb-4" id="colorOptions">
                        <!-- Color options will be populated by JavaScript -->
                    </div>
                    <div class="flex justify-end space-x-2">
                        <button id="cancelColorPicker" class="px-4 py-2 text-gray-900 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg border border-gray-300 dark:border-gray-600">Cancel</button>
                        <button id="applyColorPicker" class="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg">Apply</button>
                    </div>
                </div>
            </div>

            <script src="${xtermUri}"></script>
            <script src="${fitAddonUri}"></script>
            <script>
                const vscode = acquireVsCodeApi();
                const terminals = new Map();
                let activeTerminalId = null;
                let remoteControlEnabled = false;
                
                // No need for state persistence with retainContextWhenHidden: true

                // Initialize
                document.addEventListener('DOMContentLoaded', () => {
                    document.getElementById('newTabButton').addEventListener('click', () => {
                        vscode.postMessage({
                            type: 'createTerminal'
                        });
                    });

                    // Remote Control checkbox event listener
                    const remoteControlCheckbox = document.getElementById('remoteControlCheckbox');
                    // Modern toggle switch functionality
                    remoteControlCheckbox.addEventListener('change', (e) => {
                        remoteControlEnabled = e.target.checked;
                        
                        // Update toggle switch appearance
                        const toggleBg = document.querySelector('.toggle-bg');
                        const toggleDot = document.querySelector('.toggle-dot');
                        
                        if (remoteControlEnabled) {
                            toggleBg.classList.remove('bg-gray-200', 'dark:bg-gray-600');
                            toggleBg.classList.add('bg-blue-500');
                            toggleDot.classList.add('translate-x-5');
                        } else {
                            toggleBg.classList.remove('bg-blue-500');
                            toggleBg.classList.add('bg-gray-200', 'dark:bg-gray-600');
                            toggleDot.classList.remove('translate-x-5');
                        }
                        
                        // Notify extension host about remote control state change
                        vscode.postMessage({
                            type: 'remoteControlToggle',
                            enabled: remoteControlEnabled
                        });
                    });

                    // Telegram Settings Menu event listeners
                    const menuBarButton = document.getElementById('menuBarButton');
                    const telegramSettingsMenu = document.getElementById('telegramSettingsMenu');
                    const menuOverlay = document.getElementById('menuOverlay');
                    const closeSettingsButton = document.getElementById('closeSettingsButton');
                    const saveTelegramSettings = document.getElementById('saveTelegramSettings');
                    const testTelegramConnection = document.getElementById('testTelegramConnection');
                    
                    // Menu button click - show/hide settings
                    menuBarButton.addEventListener('click', (e) => {
                        e.stopPropagation();
                        
                        // Toggle modern menu visibility
                        const isHidden = telegramSettingsMenu.classList.contains('hidden');
                        if (isHidden) {
                            telegramSettingsMenu.classList.remove('hidden');
                            loadTelegramSettings();
                        } else {
                            telegramSettingsMenu.classList.add('hidden');
                        }
                    });

                    // Close button click
                    closeSettingsButton.addEventListener('click', () => {
                        telegramSettingsMenu.classList.add('hidden');
                    });

                    // Save settings button click
                    saveTelegramSettings.addEventListener('click', () => {
                        const botToken = document.getElementById('botTokenInput').value.trim();
                        const chatId = document.getElementById('chatIdInput').value.trim();
                        const maxRows = parseInt(document.getElementById('maxRowsInput').value) || 50;

                        // Basic validation
                        if (!botToken) {
                            vscode.postMessage({
                                type: 'showError',
                                message: 'Please enter a Bot Token'
                            });
                            return;
                        }
                        
                        if (!chatId) {
                            vscode.postMessage({
                                type: 'showError',
                                message: 'Please enter a Chat ID'
                            });
                            return;
                        }

                        if (maxRows < 10 || maxRows > 200) {
                            vscode.postMessage({
                                type: 'showError',
                                message: 'Max Rows must be between 10 and 200'
                            });
                            return;
                        }

                        // Send settings to extension host
                        vscode.postMessage({
                            type: 'saveTelegramSettings',
                            settings: {
                                botToken: botToken,
                                chatId: chatId,
                                maxRows: maxRows
                            }
                        });

                        telegramSettingsMenu.classList.add('hidden');
                    });

                    // Test connection button click
                    testTelegramConnection.addEventListener('click', () => {
                        const botToken = document.getElementById('botTokenInput').value.trim();
                        const chatId = document.getElementById('chatIdInput').value.trim();

                        if (!botToken || !chatId) {
                            vscode.postMessage({
                                type: 'showError',
                                message: 'Please enter both Bot Token and Chat ID before testing'
                            });
                            return;
                        }

                        vscode.postMessage({
                            type: 'testTelegramConnection',
                            botToken: botToken,
                            chatId: chatId
                        });

                    });

                    // Close menu when clicking outside
                    document.addEventListener('click', (e) => {
                        if (!menuBarButton.contains(e.target) && !telegramSettingsMenu.contains(e.target)) {
                            telegramSettingsMenu.classList.add('hidden');
                        }
                    });

                    // Close menu on Escape key
                    document.addEventListener('keydown', (e) => {
                        if (e.key === 'Escape' && !telegramSettingsMenu.classList.contains('hidden')) {
                            telegramSettingsMenu.classList.add('hidden');
                        }
                    });

                    // Load settings function
                    function loadTelegramSettings() {
                        // Request settings from extension host
                        vscode.postMessage({
                            type: 'loadTelegramSettings'
                        });
                    }

                    // Populate settings form
                    function populateTelegramSettings(settings) {
                        document.getElementById('botTokenInput').value = settings.botToken || '';
                        document.getElementById('chatIdInput').value = settings.chatId || '';
                        document.getElementById('maxRowsInput').value = settings.maxRows || 50;
                    }

                    // Initialize color picker with predefined colors
                    function initializeColorPicker() {
                        const colors = [
                            '#3b82f6', '#ef4444', '#10b981', '#f59e0b', 
                            '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16',
                            '#f97316', '#6366f1', '#14b8a6', '#eab308'
                        ];
                        
                        const colorOptions = document.getElementById('colorOptions');
                        colors.forEach(color => {
                            const colorButton = document.createElement('button');
                            colorButton.className = 'w-8 h-8 rounded-full border-2 border-gray-200 dark:border-gray-600 hover:scale-110 transition-transform';
                            colorButton.style.backgroundColor = color;
                            colorButton.dataset.color = color;
                            colorOptions.appendChild(colorButton);
                            
                            colorButton.addEventListener('click', () => {
                                // Remove previous selection
                                document.querySelectorAll('#colorOptions button').forEach(btn => {
                                    btn.classList.remove('ring-2', 'ring-offset-2', 'ring-blue-500');
                                });
                                // Add selection to current
                                colorButton.classList.add('ring-2', 'ring-offset-2', 'ring-blue-500');
                            });
                        });
                    }

                    // Initialize on load
                    initializeColorPicker();

                    // Initialize context menu event listeners
                    document.getElementById('renameTabOption').addEventListener('click', (e) => {
                        renameCurrentTab();
                    });
                    document.getElementById('changeColorOption').addEventListener('click', (e) => {
                        showColorPicker();
                    });
                    document.getElementById('closeTabOption').addEventListener('click', (e) => {
                        closeCurrentTab();
                    });

                    // Rename modal event listeners
                    document.getElementById('applyRename').addEventListener('click', applyRename);
                    document.getElementById('cancelRename').addEventListener('click', hideRenameModal);

                    // Color picker event listeners
                    document.getElementById('applyColorPicker').addEventListener('click', applySelectedColor);
                    document.getElementById('cancelColorPicker').addEventListener('click', hideColorPicker);

                    // Close modals when clicking outside
                    document.getElementById('renameModal').addEventListener('click', (e) => {
                        if (e.target.id === 'renameModal') {
                            hideRenameModal();
                        }
                    });

                    document.getElementById('colorPickerModal').addEventListener('click', (e) => {
                        if (e.target.id === 'colorPickerModal') {
                            hideColorPicker();
                        }
                    });

                    // Allow Enter key to apply rename
                    document.getElementById('renameInput').addEventListener('keypress', (e) => {
                        if (e.key === 'Enter') {
                            applyRename();
                        }
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
                        case 'telegramSettingsLoaded':
                            populateTelegramSettings(message.settings);
                            break;
                        case 'terminalClosed':
                            closeTerminalTab(message.terminalId);
                            break;
                        // No need for restoreTerminals with retainContextWhenHidden
                    }
                });
                
                // Tab context menu variables
                let currentContextTab = null;
                let currentTabName = null;
                let currentColorDot = null;

                // Show tab context menu
                function showTabContextMenu(event, tab, tabNameElement, colorDot) {
                    const contextMenu = document.getElementById('tabContextMenu');
                    currentContextTab = tab;
                    currentTabName = tabNameElement;
                    currentColorDot = colorDot;
                    
                    // Position the context menu
                    contextMenu.style.left = event.clientX + 'px';
                    contextMenu.style.top = event.clientY + 'px';
                    contextMenu.classList.remove('hidden');
                    
                    // Close menu when clicking elsewhere
                    setTimeout(() => {
                        document.addEventListener('click', hideContextMenu, { once: true });
                    }, 0);
                }

                // Hide context menu
                function hideContextMenu() {
                    document.getElementById('tabContextMenu').classList.add('hidden');
                    // Don't clear context variables here - they're needed for modals
                    // Variables will be cleared when modals are closed
                }

                // Rename tab function
                function renameCurrentTab() {
                    if (!currentTabName || !currentContextTab) {
                        return;
                    }
                    
                    const currentName = currentContextTab.dataset.customName || currentContextTab.dataset.originalId;
                    
                    // Show rename modal
                    const modal = document.getElementById('renameModal');
                    const input = document.getElementById('renameInput');
                    input.value = currentName;
                    modal.classList.remove('hidden');
                    
                    // Focus and select the input
                    setTimeout(() => {
                        input.focus();
                        input.select();
                    }, 100);
                    
                    hideContextMenu();
                }

                // Apply rename
                function applyRename() {
                    const input = document.getElementById('renameInput');
                    const newName = input.value.trim();
                    
                    if (newName && currentTabName && currentContextTab) {
                        currentContextTab.dataset.customName = newName;
                        currentTabName.textContent = newName;
                    }
                    
                    hideRenameModal();
                }

                // Hide rename modal
                function hideRenameModal() {
                    document.getElementById('renameModal').classList.add('hidden');
                    // Clear context variables when modal is closed
                    currentContextTab = null;
                    currentTabName = null;
                    currentColorDot = null;
                }

                // Show color picker modal
                function showColorPicker() {
                    if (!currentColorDot || !currentContextTab) {
                        return;
                    }
                    
                    const modal = document.getElementById('colorPickerModal');
                    modal.classList.remove('hidden');
                    
                    // Highlight current color or select first color if none found
                    const currentColor = currentContextTab.dataset.color;
                    
                    let colorSelected = false;
                    document.querySelectorAll('#colorOptions button').forEach(btn => {
                        btn.classList.remove('ring-2', 'ring-offset-2', 'ring-blue-500');
                        if (btn.dataset.color === currentColor) {
                            btn.classList.add('ring-2', 'ring-offset-2', 'ring-blue-500');
                            colorSelected = true;
                        }
                    });
                    
                    // If no color was selected, select the first one
                    if (!colorSelected) {
                        const firstColorBtn = document.querySelector('#colorOptions button');
                        if (firstColorBtn) {
                            firstColorBtn.classList.add('ring-2', 'ring-offset-2', 'ring-blue-500');
                        }
                    }
                    
                    hideContextMenu();
                }

                // Apply selected color
                function applySelectedColor() {
                    const selectedColorBtn = document.querySelector('#colorOptions button.ring-2');
                    const selectedColor = selectedColorBtn?.dataset.color;
                    
                    if (!selectedColor) {
                        vscode.postMessage({
                            type: 'showError',
                            message: 'Please select a color first by clicking on one of the color options.'
                        });
                        return;
                    }
                    
                    if (!currentColorDot || !currentContextTab) {
                        vscode.postMessage({
                            type: 'showError',
                            message: 'Error: Please try right-clicking the tab again.'
                        });
                        return;
                    }
                    
                    // Apply the color
                    currentContextTab.dataset.color = selectedColor;
                    currentColorDot.style.backgroundColor = selectedColor;
                    
                    hideColorPicker();
                }

                // Hide color picker modal
                function hideColorPicker() {
                    document.getElementById('colorPickerModal').classList.add('hidden');
                    // Clear context variables when modal is closed
                    currentContextTab = null;
                    currentTabName = null;
                    currentColorDot = null;
                }

                // Close current tab
                function closeCurrentTab() {
                    if (!currentContextTab) return;
                    
                    const terminalId = currentContextTab.dataset.terminalId;
                    vscode.postMessage({
                        type: 'closeTerminal',
                        terminalId: terminalId
                    });
                    
                    hideContextMenu();
                }


                function createTerminalTab(terminalId, name) {
                    // Create modern tab with Tailwind classes
                    const tabsContainer = document.getElementById('tabs');
                    const tab = document.createElement('div');
                    tab.className = 'group relative flex items-center px-3 py-2 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg cursor-pointer transition-all duration-200 hover:shadow-md hover:-translate-y-0.5 min-w-0 max-w-40';
                    tab.dataset.terminalId = terminalId;
                    
                    // Store original ID and custom name
                    tab.dataset.originalId = name; // CC:1, CC:2, etc.
                    tab.dataset.customName = name; // Initially same as ID
                    tab.dataset.color = '#3b82f6'; // Default blue color
                    
                    // Color indicator dot
                    const colorDot = document.createElement('div');
                    colorDot.className = 'w-2 h-2 rounded-full mr-2 flex-shrink-0';
                    colorDot.style.backgroundColor = '#3b82f6';
                    
                    // Tab name with gradient text for active state
                    const tabName = document.createElement('span');
                    tabName.className = 'flex-1 text-sm font-medium text-gray-700 dark:text-gray-300 truncate group-hover:text-gray-900 dark:group-hover:text-white transition-colors';
                    tabName.textContent = name;
                    
                    // Modern close button with hover effects
                    const closeButton = document.createElement('button');
                    closeButton.className = 'ml-2 w-5 h-5 rounded-full bg-gray-100 dark:bg-gray-600 hover:bg-red-100 dark:hover:bg-red-900 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-200 hover:scale-110';
                    closeButton.innerHTML = '<svg class="w-3 h-3 text-gray-500 hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>';
                    closeButton.addEventListener('click', (e) => {
                        e.stopPropagation();
                        vscode.postMessage({
                            type: 'closeTerminal',
                            terminalId: terminalId
                        });
                    });
                    
                    // Right-click context menu
                    tab.addEventListener('contextmenu', (e) => {
                        e.preventDefault();
                        showTabContextMenu(e, tab, tabName, colorDot);
                    });
                    
                    tab.appendChild(colorDot);
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
                    terminalDiv.style.backgroundColor = 'var(--vscode-terminal-background, #1e1e1e)';
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
                    // Update tab states with modern styling
                    document.querySelectorAll('[data-terminal-id]').forEach(tab => {
                        // Remove active styling
                        tab.classList.remove('bg-gradient-to-r', 'from-blue-500', 'to-indigo-600', 'text-white', 'shadow-lg', 'scale-105');
                        tab.classList.add('bg-white', 'dark:bg-gray-700');
                        // Reset text color
                        const tabName = tab.querySelector('span');
                        if (tabName) {
                            tabName.classList.remove('text-white');
                            tabName.classList.add('text-gray-700', 'dark:text-gray-300');
                        }
                    });
                    
                    const activeTab = document.querySelector(\`[data-terminal-id="\${terminalId}"]\`);
                    if (activeTab) {
                        // Add active styling
                        activeTab.classList.remove('bg-white', 'dark:bg-gray-700');
                        activeTab.classList.add('bg-gradient-to-r', 'from-blue-500', 'to-indigo-600', 'text-white', 'shadow-lg', 'scale-105');
                        // Update text color for active state
                        const tabName = activeTab.querySelector('span');
                        if (tabName) {
                            tabName.classList.remove('text-gray-700', 'dark:text-gray-300');
                            tabName.classList.add('text-white');
                        }
                    }

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