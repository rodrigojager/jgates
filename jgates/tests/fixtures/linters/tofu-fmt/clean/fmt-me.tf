variable "name" {
  type    = string
  default = "x"
}

output "name" {
  value = var.name
}
