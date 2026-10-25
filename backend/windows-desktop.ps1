$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
Add-Type -Path (Join-Path $PSScriptRoot 'windows-desktop.cs') -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase
[LLMPetDesktop]::Init()
while ($null -ne ($line = [Console]::ReadLine())) {
    $request = $null
    try {
        $request = $line | ConvertFrom-Json
        $w = $request.target
        switch ($request.command) {
            'scan' { $data = @([LLMPetDesktop]::Scan([string[]]$request.names)) }
            'read' { $data = [LLMPetDesktop]::Read([string]$request.hwnd) }
            'idle' { $data = [LLMPetDesktop]::IdleSeconds() }
            'move' { $data = [LLMPetDesktop]::Move($w.hwnd, $w.pid, $w.name, $w.title, $w.className, $request.x, $request.y) }
            'close' { [LLMPetDesktop]::Close($w.hwnd, $w.pid, $w.name, $w.title, $w.className); $data = $true }
            default { throw 'unknown-command' }
        }
        $response = @{ id=$request.id; ok=$true; data=$data }
    } catch {
        $response = @{ id=$request.id; ok=$false; error=$_.Exception.Message }
    }
    [Console]::WriteLine(($response | ConvertTo-Json -Depth 12 -Compress))
}
