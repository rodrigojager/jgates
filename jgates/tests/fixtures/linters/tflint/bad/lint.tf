variable "unused" {
  type = string
}

variable "untyped" {}

output "echo" {
  value = "${var.untyped}"
}
