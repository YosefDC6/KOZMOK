// public/js/fotos.js
// Fotos para reclamos de garantía: el navegador las reduce (máx. 1600 px,
// JPEG) antes de mandarlas, así pesan poco y no viajan datos de ubicación
// (al redibujar en un canvas se pierden los metadatos EXIF).
(function () {
    const MAX_FOTOS = 3;
    const LADO = 1600;

    function reducir(archivo) {
        return new Promise((resolver, rechazar) => {
            if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(archivo.type) && !/\.(jpe?g|png|webp)$/i.test(archivo.name)) {
                rechazar(new Error(`"${archivo.name}" no es una foto (usa JPG, PNG o WebP)`));
                return;
            }
            // Se lee como data: (la política de seguridad no permite blob:).
            const lector = new FileReader();
            const img = new Image();
            img.onload = () => {
                const escala = Math.min(1, LADO / Math.max(img.width, img.height));
                const c = document.createElement('canvas');
                c.width = Math.round(img.width * escala);
                c.height = Math.round(img.height * escala);
                c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                let calidad = 0.82;
                let datos = c.toDataURL('image/jpeg', calidad);
                while (datos.length > 1.9e6 && calidad > 0.4) { calidad -= 0.1; datos = c.toDataURL('image/jpeg', calidad); }
                resolver({ nombre: archivo.name.replace(/\.[^.]+$/, '') + '.jpg', datos });
            };
            img.onerror = () => rechazar(new Error(`No se pudo leer "${archivo.name}"`));
            lector.onload = () => { img.src = lector.result; };
            lector.onerror = () => rechazar(new Error(`No se pudo leer "${archivo.name}"`));
            lector.readAsDataURL(archivo);
        });
    }

    // Conecta un <input type="file"> con una lista de fotos y su vista previa.
    // Devuelve { fotos(), limpiar() }.
    function selector(input, vista, { alError } = {}) {
        let fotos = [];
        const pintar = () => {
            vista.innerHTML = fotos.map((f, i) => `
                <span class="foto-prev"><img src="${f.datos}" alt="" />
                    <button type="button" aria-label="Quitar foto" data-i="${i}">×</button></span>`).join('');
            vista.querySelectorAll('button[data-i]').forEach((b) => b.addEventListener('click', () => { fotos.splice(Number(b.dataset.i), 1); pintar(); }));
        };
        input.addEventListener('change', async () => {
            const nuevos = [...input.files];
            input.value = '';
            for (const a of nuevos) {
                if (fotos.length >= MAX_FOTOS) { if (alError) alError(`Máximo ${MAX_FOTOS} fotos`); break; }
                try { fotos.push(await reducir(a)); } catch (e) { if (alError) alError(e.message); }
            }
            pintar();
        });
        return { fotos: () => fotos.slice(), limpiar: () => { fotos = []; pintar(); } };
    }

    window.FotosReclamo = { selector, MAX_FOTOS };
})();
