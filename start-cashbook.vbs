Option Explicit

Dim shell, fileSystem, appDir, appUrl, serverScript, logFile, ready, attempt
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

appDir = "D:\Web Cashbook"
appUrl = "http://localhost:5173/"
serverScript = appDir & "\run-cashbook-server.cmd"
logFile = appDir & "\cashbook-server.log"

shell.CurrentDirectory = appDir
shell.Run "cmd.exe /c """ & serverScript & """", 0, False

ready = False
For attempt = 1 To 30
  If IsSiteReady(appUrl) Then
    ready = True
    Exit For
  End If
  WScript.Sleep 500
Next

If ready Then
  shell.Run appUrl, 1, False
Else
  MsgBox "Cashbook could not start. Check """ & logFile & """ for details.", 48, "Cashbook Local"
End If

Function IsSiteReady(url)
  Dim request
  On Error Resume Next
  Set request = CreateObject("WinHttp.WinHttpRequest.5.1")
  request.Open "GET", url, False
  request.SetTimeouts 1000, 1000, 1000, 1000
  request.Send
  IsSiteReady = (Err.Number = 0 And request.Status >= 200 And request.Status < 500)
  Err.Clear
  On Error GoTo 0
End Function