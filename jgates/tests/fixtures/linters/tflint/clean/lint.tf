terraform {
  required_version = ">= 1.0"
}

variable "region" {
  type = string
}

output "region" {
  value = var.region
}
