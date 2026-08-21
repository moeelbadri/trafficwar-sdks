from django.db import models


class Greeting(models.Model):
    name = models.CharField(max_length=100, unique=True)
    message = models.CharField(max_length=255)

    def __str__(self) -> str:
        return f"{self.name}: {self.message}"
