
# -force so it gets hidden files, i.e., .git
Get-ChildItem $args[0] -Recurse -force  | ForEach-Object {
    # Do something with the file size. cleverly, $_.length for
    # a directory is always 1 - not a real size, not zero (even
    # though it's zero). powershell is awesome.
    if ($_.psiscontainer) {
      Write-Host "0 $($_.FullName) d"
    } else {
      Write-Host "$($_.length) $($_.fullname) f"
    }
}


#Read more: https://www.sharepointdiary.com/2020/10/powershell-get-file-size.html#ixzz8K0L1VN1r

# (get-item .).fullname - current working directory

# join-path (get-item .).fullname "node_modules\.bin"
# C:\Users\bamac\github\bmacnaughton\action-walk\node_modules\.bin
