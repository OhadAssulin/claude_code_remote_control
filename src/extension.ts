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

                /* Remote Control Section Styles */
                .remote-control-section {
                    display: flex;
                    align-items: center;
                    margin-left: auto;
                    gap: 12px;
                    padding-right: 8px;
                }

                .remote-control-label {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    cursor: pointer;
                    user-select: none;
                    font-size: 12px;
                    color: var(--vscode-foreground);
                }

                .remote-control-checkbox {
                    width: 16px;
                    height: 16px;
                    margin: 0;
                    cursor: pointer;
                    accent-color: var(--vscode-checkbox-foreground, #0078d4);
                }

                .remote-control-text {
                    font-weight: 500;
                    white-space: nowrap;
                }

                /* Menu Bar Container */
                .menu-bar-container {
                    position: relative;
                    display: flex;
                    align-items: center;
                }

                .menu-bar-button {
                    background: none;
                    border: none;
                    color: var(--vscode-foreground);
                    cursor: pointer;
                    padding: 6px;
                    border-radius: 4px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: background-color 0.2s ease;
                }

                .menu-bar-button:hover {
                    background-color: var(--vscode-toolbar-hoverBackground);
                }

                .menu-bar-button:active {
                    background-color: var(--vscode-toolbar-activeBackground, var(--vscode-toolbar-hoverBackground));
                }

                .menu-icon {
                    width: 16px;
                    height: 16px;
                    color: inherit;
                }

                /* Telegram Settings Menu Styles */
                .telegram-settings-menu {
                    position: fixed;
                    top: 70px;
                    right: 20px;
                    background: var(--vscode-menu-background, var(--vscode-dropdown-background));
                    border: 1px solid var(--vscode-menu-border, var(--vscode-dropdown-border));
                    border-radius: 6px;
                    box-shadow: var(--vscode-widget-shadow, 0 4px 16px rgba(0, 0, 0, 0.2));
                    min-width: 320px;
                    max-width: 400px;
                    z-index: 9999;
                    display: none;
                }

                .telegram-settings-menu.show {
                    display: block;
                    animation: fadeIn 0.2s ease-out;
                }

                @keyframes fadeIn {
                    from { opacity: 0; transform: translateY(-10px); }
                    to { opacity: 1; transform: translateY(0); }
                }

                /* Menu overlay for debugging */
                .menu-overlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background: rgba(0, 0, 0, 0.1);
                    z-index: 9998;
                    display: none;
                }

                .menu-overlay.show {
                    display: block;
                }

                .settings-header {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    padding: 12px 16px;
                    border-bottom: 1px solid var(--vscode-menu-border, var(--vscode-dropdown-border));
                    background: var(--vscode-menu-background, var(--vscode-dropdown-background));
                    font-weight: 600;
                    font-size: 14px;
                    color: var(--vscode-menu-foreground, var(--vscode-dropdown-foreground));
                }

                .telegram-icon {
                    width: 16px;
                    height: 16px;
                    color: #0088cc;
                    flex-shrink: 0;
                }

                .close-settings {
                    background: none;
                    border: none;
                    color: var(--vscode-menu-foreground, var(--vscode-dropdown-foreground));
                    cursor: pointer;
                    font-size: 18px;
                    font-weight: bold;
                    margin-left: auto;
                    padding: 2px 6px;
                    border-radius: 3px;
                    transition: background-color 0.2s ease;
                }

                .close-settings:hover {
                    background-color: var(--vscode-toolbar-hoverBackground);
                }

                .settings-form {
                    padding: 16px;
                }

                .form-group {
                    margin-bottom: 16px;
                }

                .form-group label {
                    display: block;
                    margin-bottom: 6px;
                    font-size: 13px;
                    font-weight: 500;
                    color: var(--vscode-menu-foreground, var(--vscode-dropdown-foreground));
                }

                .form-input {
                    width: 100%;
                    padding: 8px 12px;
                    border: 1px solid var(--vscode-input-border, var(--vscode-dropdown-border));
                    border-radius: 4px;
                    background: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    font-size: 13px;
                    box-sizing: border-box;
                    transition: border-color 0.2s ease;
                }

                .form-input:focus {
                    outline: none;
                    border-color: var(--vscode-focusBorder, #0078d4);
                    box-shadow: 0 0 0 1px var(--vscode-focusBorder, #0078d4);
                }

                .form-input::placeholder {
                    color: var(--vscode-input-placeholderForeground);
                }

                .form-actions {
                    display: flex;
                    gap: 8px;
                    margin-top: 20px;
                }

                .btn {
                    padding: 8px 16px;
                    border: none;
                    border-radius: 4px;
                    font-size: 13px;
                    font-weight: 500;
                    cursor: pointer;
                    transition: background-color 0.2s ease;
                    outline: none;
                }

                .btn-primary {
                    background: var(--vscode-button-background, #0078d4);
                    color: var(--vscode-button-foreground, white);
                }

                .btn-primary:hover {
                    background: var(--vscode-button-hoverBackground, #106ebe);
                }

                .btn-secondary {
                    background: var(--vscode-button-secondaryBackground, transparent);
                    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
                    border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder));
                }

                .btn-secondary:hover {
                    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground));
                }
            </style>
        </head>
        <body>
            <div class="tab-container">
                <div id="tabs" style="display: flex; flex-direction: row; align-items: center;"></div>
                <button class="new-tab-button" id="newTabButton">+</button>
                
                <!-- Remote Control Section -->
                <div class="remote-control-section">
                    <label class="remote-control-label">
                        <input type="checkbox" id="remoteControlCheckbox" class="remote-control-checkbox">
                        <span class="remote-control-text">Remote Control</span>
                    </label>
                    
                    <!-- Menu Bar Icon -->
                    <div class="menu-bar-container">
                        <button class="menu-bar-button" id="menuBarButton" title="Options">
                            <svg class="menu-icon" viewBox="0 0 16 16" width="16" height="16">
                                <circle fill="currentColor" cx="8" cy="3" r="1.5"/>
                                <circle fill="currentColor" cx="8" cy="8" r="1.5"/>
                                <circle fill="currentColor" cx="8" cy="13" r="1.5"/>
                            </svg>
                        </button>
                        
                        <!-- Telegram Settings Menu -->
                        <div class="telegram-settings-menu" id="telegramSettingsMenu">
                            <div class="settings-header">
                                <svg class="telegram-icon" viewBox="0 0 16 16" width="16" height="16">
                                    <path fill="currentColor" d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0zM8.287 5.906c-.778.324-2.334.994-4.666 2.01-.378.15-.577.298-.595.442-.03.243.275.339.69.47l.175.055c.408.133.958.288 1.243.294.26.006.549-.1.868-.32 2.179-1.471 3.304-2.214 3.374-2.23.05-.012.12-.026.166.016.047.041.042.12.037.141-.03.129-1.227 1.241-1.846 1.817-.193.18-.33.307-.358.336a8.154 8.154 0 0 1-.188.186c-.38.366-.664.64.015 1.088.327.216.589.393.85.571.284.194.568.387.936.629.093.06.183.125.27.187.331.236.63.448.997.414.214-.02.435-.22.547-.82.265-1.417.786-4.486.906-5.751a1.426 1.426 0 0 0-.013-.315.337.337 0 0 0-.114-.217.526.526 0 0 0-.31-.093c-.3.005-.763.166-2.984 1.09z"/>
                                </svg>
                                <span>Telegram Settings</span>
                                <button class="close-settings" id="closeSettingsButton" title="Close">×</button>
                            </div>
                            
                            <div class="settings-form">
                                <div class="form-group">
                                    <label for="botTokenInput">Bot Token:</label>
                                    <input type="text" id="botTokenInput" placeholder="Enter your Telegram Bot Token" class="form-input">
                                </div>
                                
                                <div class="form-group">
                                    <label for="chatIdInput">Chat ID:</label>
                                    <input type="text" id="chatIdInput" placeholder="Enter your Chat ID" class="form-input">
                                </div>
                                
                                <div class="form-group">
                                    <label for="maxRowsInput">Max Rows:</label>
                                    <input type="number" id="maxRowsInput" placeholder="50" min="10" max="200" class="form-input">
                                </div>
                                
                                <div class="form-actions">
                                    <button class="btn btn-primary" id="saveTelegramSettings">Save Settings</button>
                                    <button class="btn btn-secondary" id="testTelegramConnection">Test Connection</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- Menu Overlay -->
            <div class="menu-overlay" id="menuOverlay"></div>
            
            <div class="terminal-container" id="terminalContainer">
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
                    remoteControlCheckbox.addEventListener('change', (e) => {
                        remoteControlEnabled = e.target.checked;
                        console.log('Remote Control', remoteControlEnabled ? 'enabled' : 'disabled');
                        
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
                        console.log('🔘 Menu button clicked!');
                        
                        telegramSettingsMenu.classList.toggle('show');
                        console.log('📱 Menu visibility:', telegramSettingsMenu.classList.contains('show') ? 'SHOWN' : 'HIDDEN');
                        
                        // Load current settings when opening
                        if (telegramSettingsMenu.classList.contains('show')) {
                            loadTelegramSettings();
                        }
                    });

                    // Close button click
                    closeSettingsButton.addEventListener('click', () => {
                        telegramSettingsMenu.classList.remove('show');
                    });

                    // Save settings button click
                    saveTelegramSettings.addEventListener('click', () => {
                        const botToken = document.getElementById('botTokenInput').value.trim();
                        const chatId = document.getElementById('chatIdInput').value.trim();
                        const maxRows = parseInt(document.getElementById('maxRowsInput').value) || 50;

                        // Basic validation
                        if (!botToken) {
                            alert('Please enter a Bot Token');
                            return;
                        }
                        
                        if (!chatId) {
                            alert('Please enter a Chat ID');
                            return;
                        }

                        if (maxRows < 10 || maxRows > 200) {
                            alert('Max Rows must be between 10 and 200');
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

                        console.log('💾 Telegram settings saved:', { botToken: botToken.substring(0, 10) + '...', chatId, maxRows });
                        telegramSettingsMenu.classList.remove('show');
                    });

                    // Test connection button click
                    testTelegramConnection.addEventListener('click', () => {
                        const botToken = document.getElementById('botTokenInput').value.trim();
                        const chatId = document.getElementById('chatIdInput').value.trim();

                        if (!botToken || !chatId) {
                            alert('Please enter both Bot Token and Chat ID before testing');
                            return;
                        }

                        vscode.postMessage({
                            type: 'testTelegramConnection',
                            botToken: botToken,
                            chatId: chatId
                        });

                        console.log('🧪 Testing Telegram connection...');
                    });

                    // Close menu when clicking outside
                    document.addEventListener('click', (e) => {
                        if (!menuBarButton.contains(e.target) && !telegramSettingsMenu.contains(e.target)) {
                            telegramSettingsMenu.classList.remove('show');
                        }
                    });

                    // Close menu on Escape key
                    document.addEventListener('keydown', (e) => {
                        if (e.key === 'Escape' && telegramSettingsMenu.classList.contains('show')) {
                            telegramSettingsMenu.classList.remove('show');
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