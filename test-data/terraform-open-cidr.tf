Terraform will perform the following actions:

  # aws_security_group.bastion will be updated in-place
  ~ resource "aws_security_group" "bastion" {
        id          = "sg-0a1b2c3d4e5f"
        name        = "bastion-sg"
      ~ ingress {
          ~ cidr_blocks = [
              - "10.20.0.0/16",
              + "0.0.0.0/0",
            ]
            from_port   = 22
            to_port     = 22
            protocol    = "tcp"
            description = "SSH"
        }
        tags = {
            "Environment" = "production"
            "Name"        = "bastion"
        }
    }

Plan: 0 to add, 1 to change, 0 to destroy.
