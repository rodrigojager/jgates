variable "nope" {
  type    = string
  default = "x"
}

output "missing" {
  value = var.nope
}
