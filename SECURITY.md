# Security policy

Rollprobe is an **experimental MVP**. It provisions disposable PostgreSQL containers and runs local HTTP fixtures. Do not point it at production databases or sensitive workloads.

Please report vulnerabilities privately via GitHub's private vulnerability reporting feature if enabled, or contact the repository maintainer directly. Avoid filing public issues containing credentials or exploitable secrets.

The hash-chained evidence format detects accidental changes and ordinary tampering, but it is not a cryptographically signed or externally anchored audit log.
