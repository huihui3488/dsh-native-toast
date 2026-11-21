' Runs one command line with no console window.
' wscript.exe is a GUI-subsystem host, so it never allocates a console; the
' child is started with window style 0 (hidden).
'   wscript.exe //B //Nologo hidden.vbs "<executable>" [args...]
Dim shell
Dim command
Dim index
Dim argument

Set shell = CreateObject("WScript.Shell")
command = ""
For index = 0 To WScript.Arguments.Count - 1
    argument = WScript.Arguments(index)
    If index > 0 Then command = command & " "
    command = command & """" & Replace(argument, """", """""") & """"
Next
If command <> "" Then shell.Run command, 0, False
