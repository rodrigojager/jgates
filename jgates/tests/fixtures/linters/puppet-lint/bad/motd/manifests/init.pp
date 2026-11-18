# Manage the message of the day.
class motd {
  file { '/etc/motd':
    ensure  => file,
    content => "Welcome",
  }
}
