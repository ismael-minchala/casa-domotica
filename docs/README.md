# Documentación técnica

- [`documentacion-tecnica.pdf`](documentacion-tecnica.pdf): documento compilado.
- [`latex/documentacion-tecnica.tex`](latex/documentacion-tecnica.tex): fuente LaTeX; los diagramas están hechos con TikZ.

Contenido: requisitos, arquitectura (contexto, capas, componentes, despliegue), topología y direccionamiento
de red, puertos, subsistemas (LCN, energía solar y autonomía de la batería, ahorro automático, cámaras,
Tuya y TV, portón y luz exterior por eWeLink, aspiradora, apagado general, monitor de red) con diagramas de
secuencia, flujo de datos y máquina de estados, modelo de datos, catálogo de reglas, operación (respaldo,
restauración, incidentes), seguridad, cronología y hoja de ruta.

Versión actual: 1.1 (19/11/2026).

## Compilar

Requiere MiKTeX (o TeX Live) con instalación automática de paquetes:

```powershell
cd docs\latex
pdflatex documentacion-tecnica.tex
pdflatex documentacion-tecnica.tex   # segunda pasada: índice y referencias
copy documentacion-tecnica.pdf ..\
```
